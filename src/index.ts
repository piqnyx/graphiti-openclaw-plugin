import {
  createCapturePipeline,
  resolveDurableCaptureRoot,
  type CapturePipeline,
} from "./capture-pipeline.js";
import { CaptureLeaseHeldError } from "./capture-lease.js";
import { acquireCaptureRuntime, type AcquireResult } from "./capture-runtime.js";
import { parseConfig, type GraphitiPluginConfig } from "./config.js";
import { requireAgentId } from "./identity.js";
import { createGraphitiLogger } from "./logging.js";
import { compileSessionPatterns, matchSessionExclusion } from "./session-filter.js";
import { GraphitiMcpClient } from "./mcp-client.js";
import {
  buildRecallBlockDetailed,
  buildRecallQuery,
  factsInForce,
  factTextsInForce,
  isSupersededFact,
  sanitizeConversationText,
  SESSION_RESET_PROMPT_PREFIX,
} from "./text.js";
import { expandFacts, type FactContext } from "./recall-expand.js";
import { createGraphitiTools } from "./tools.js";
import type {
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
  HookContext,
  LlmInputEvent,
  OpenClawPluginApi,
} from "./types.js";

export const id = "graphiti-openclaw-plugin";
export const name = "Graphiti Companion";
export const description =
  "Slot-less per-agent Graphiti auto-capture and auto-recall companion for OpenClaw";

const GATEWAY_STOP_HOOK_TIMEOUT_MS = 4_500;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function standaloneClient(cfg: GraphitiPluginConfig): GraphitiMcpClient {
  return new GraphitiMcpClient(cfg.baseUrl, cfg.requestTimeoutMs);
}

export function register(api: OpenClawPluginApi): void {
  let cfg: GraphitiPluginConfig;
  try {
    cfg = parseConfig(api.pluginConfig);
  } catch (error) {
    api.logger.error(`graphiti: event=config_invalid error=${JSON.stringify(errorText(error))}`);
    throw error;
  }

  const logger = createGraphitiLogger(api.logger, cfg);
  const excludedSessionPatterns = compileSessionPatterns(cfg.excludeSessionPatterns);

  let capture: CapturePipeline | undefined;
  let client: GraphitiMcpClient;
  let captureOutcome = "disabled";

  let acquired: AcquireResult<CapturePipeline> | undefined;
  if (cfg.autoCapture) {
    try {
      acquired = acquireCaptureRuntime<CapturePipeline>({
        fingerprint: JSON.stringify({ cfg, durableRoot: resolveDurableCaptureRoot() }),
        isStopped: (candidate) => candidate.engine.isStopped(),
        create: () => createCapturePipeline({ api, cfg, logger, excludedSessionPatterns }),
      });
    } catch (error) {
      // Losing the race for the spool costs this registration its writing, and
      // nothing else: reading memory needs only the MCP client. Failing the whole
      // register took recall and the tools down with the capture, so a second
      // module realm in one process ended up with no memory at all rather than
      // with read-only memory. Every other failure here still stands -- a
      // malformed lock or an unmigrated legacy spool means the state on disk is
      // not what this code believes, and carrying on past that invents a writer.
      if (!(error instanceof CaptureLeaseHeldError)) throw error;
      captureOutcome = "owned_elsewhere";
      logger.warn("capture_spool_owned_elsewhere", {
        ownerPid: error.ownerPid,
        detail: "another live owner holds the spool; this registration reads memory but does not write it",
      });
    }
  }

  if (acquired) {
    capture = acquired.runtime;
    captureOutcome = acquired.outcome;
    client = capture.client;

    api.on("agent_end", capture.handleAgentEnd);
    api.on(
      "gateway_stop",
      async () => {
        try {
          await capture?.shutdown();
        } catch (error) {
          logger.error("capture_shutdown_failed", { error: errorText(error) });
        }
      },
      { timeoutMs: GATEWAY_STOP_HOOK_TIMEOUT_MS },
    );

    if (captureOutcome !== "reused") logger.info("capture_pipeline", { outcome: captureOutcome });
  } else {
    client = standaloneClient(cfg);
  }

  if (cfg.agentTools && api.registerTool) {
    const tools = createGraphitiTools({
      cfg,
      client,
      logger,
      excludedSessionPatterns,
      captureNote: (agentId, sessionKey, note) => {
        if (!capture)
          throw new Error(
            "Graphiti is not writing memory in this process, so a note cannot be queued: auto-capture is off, or another live owner holds the capture spool",
          );
        capture.captureNote(agentId, sessionKey, note);
      },
      localCaptureState: (agentId) =>
        capture
          ? capture.localCaptureState(agentId)
          : {
              awaitingConfirmation: 0,
              awaitingBytes: 0,
              notLanding: [],
              droppedForSpace: 0,
              bufferedMessages: 0,
              queuedBatches: 0,
            },
    });
    for (const tool of tools) {
      api.registerTool(
        (ctx) => ({ ...tool, execute: (toolCallId, params) => tool.execute(toolCallId, params, ctx) }),
        { name: tool.name },
      );
    }
    logger.info("agent_tools_registered", { tools: tools.map((tool) => tool.name) });
  } else if (cfg.agentTools && !api.registerTool) {
    logger.warn("agent_tools_unavailable", {
      reason: "host_does_not_expose_registerTool",
      action: "capture_and_recall_continue_normally",
    });
  }

  if (cfg.autoRecall) {
    api.on(
      "before_prompt_build",
      async (rawEvent: unknown, ctx?: HookContext): Promise<BeforePromptBuildResult | void> => {
        const event = rawEvent as BeforePromptBuildEvent;
        let agentId: string;
        try {
          agentId = requireAgentId(ctx?.agentId);
        } catch (error) {
          logger.warn("recall_skipped", { reason: "invalid_agent_id", error: errorText(error) });
          return;
        }

        const excluded = matchSessionExclusion(ctx ?? {}, excludedSessionPatterns);
        if (excluded) {
          logger.debug("recall_skipped", {
            agentId,
            group_id: agentId,
            sessionKey: ctx?.sessionKey,
            trigger: ctx?.trigger,
            reason: "excluded_session",
            pattern: excluded.pattern,
            matched: excluded.matched,
          });
          return;
        }

        const currentPrompt = sanitizeConversationText(event.prompt ?? "");
        if (!currentPrompt) {
          logger.debug("recall_skipped", { agentId, group_id: agentId, reason: "empty_query" });
          return;
        }
        if (currentPrompt.startsWith(SESSION_RESET_PROMPT_PREFIX)) {
          logger.debug("recall_skipped", { agentId, group_id: agentId, reason: "session_reset" });
          return;
        }

        // History comes from the transcript store, the same source capture reads.
        // The hook payload repeats the current message and renders a voice turn as
        // "(no content)", and both used to end up in the search query.
        const history = capture
          ? capture.recentConversation(agentId, ctx?.sessionKey ?? "", cfg.recallHistoryMaxMessages)
          : [];
        const query = buildRecallQuery(
          currentPrompt,
          history,
          {
            useHistory: cfg.recallUseHistory,
            historyMaxMessages: cfg.recallHistoryMaxMessages,
            historyMaxChars: cfg.recallHistoryMaxChars,
            maxChars: cfg.recallQueryMaxChars,
            userName: cfg.agents[agentId]?.user,
            assistantName: cfg.agents[agentId]?.assistant,
          },
        );
        if (!query) return;

        logger.debugContent(
          "recall_query",
          {
            agentId,
            group_id: agentId,
            chars: query.length,
            useHistory: cfg.recallUseHistory,
            historyMaxMessages: cfg.recallHistoryMaxMessages,
            historyMaxChars: cfg.recallHistoryMaxChars,
            queryMaxChars: cfg.recallQueryMaxChars,
          },
          { query },
        );

        const started = Date.now();
        try {
          const facts = await client.searchFacts(query, agentId, cfg.recallLimit, {
            pool: cfg.recallPool,
            rerank: cfg.recallRerank,
            minScore: cfg.recallMinScore,
            contextWeight: cfg.recallContextWeight,
            // What the reranker scores against: the message just sent, not the
            // transcript around it. The transcript is what found the candidates.
            focus: currentPrompt,
          });
          const inForce = factsInForce(facts);
          const factTexts = inForce.map((fact) => fact.fact as string);

          // A window of the conversation behind the first few facts. It is an extra:
          // a store that cannot be read, or an episode that is gone, costs the
          // context and never the recall.
          let contexts: (FactContext | undefined)[] = [];
          if (cfg.recallExpandTop > 0 && inForce.length > 0) {
            try {
              contexts = await expandFacts(
                client,
                agentId,
                inForce.slice(0, cfg.recallExpandTop),
                cfg.recallExpandChars,
              );
            } catch (error) {
              logger.warn("recall_expand_failed", {
                agentId,
                group_id: agentId,
                error: errorText(error),
              });
            }
          }
          const entries = factTexts.map((fact, index) =>
            contexts[index] ? { fact, context: contexts[index] } : fact,
          );
          const recallBlock = buildRecallBlockDetailed(entries, cfg.recallMaxInjectedChars);
          const block = recallBlock.block;
          logger.debugContent(
            "recall_payload",
            {
              agentId,
              group_id: agentId,
              retrievedFacts: factTexts.length,
              supersededFacts: facts.filter(isSupersededFact).length,
              injectedFacts: recallBlock.injectedFacts,
              skippedFacts: recallBlock.skippedFacts,
              recallLimit: cfg.recallLimit,
              maxInjectedChars: cfg.recallMaxInjectedChars,
              expandTop: cfg.recallExpandTop,
              expandedFacts: contexts.filter(Boolean).length,
              expandedChars: contexts.reduce((sum, context) => sum + (context?.text.length ?? 0), 0),
              injectedChars: block?.length ?? 0,
            },
            { facts: factTexts, injectedBlock: block ?? "" },
          );
          logger.info("recall_completed", {
            agentId,
            group_id: agentId,
            results: factTexts.length,
            injectedFacts: recallBlock.injectedFacts,
            skippedFacts: recallBlock.skippedFacts,
            injectedChars: block?.length ?? 0,
            durationMs: Date.now() - started,
          });
          return block ? { prependContext: block } : undefined;
        } catch (error) {
          logger.warn("recall_failed", {
            agentId,
            group_id: agentId,
            durationMs: Date.now() - started,
            error: errorText(error),
          });
          return;
        }
      },
      { timeoutMs: cfg.requestTimeoutMs },
    );
  }

  if (cfg.logModelInput && cfg.logOperations && cfg.logLevel === "debug" && cfg.logContent) {
    api.on("llm_input", (rawEvent: unknown, ctx?: HookContext): void => {
      const event = rawEvent as LlmInputEvent;
      logger.debugContent(
        "llm_input_raw",
        {
          agentId: ctx?.agentId,
          sessionKey: ctx?.sessionKey,
          runId: event.runId,
          provider: event.provider,
          model: event.model,
          systemPromptChars: event.systemPrompt?.length ?? 0,
          promptChars: event.prompt?.length ?? 0,
          historyMessages: Array.isArray(event.historyMessages) ? event.historyMessages.length : 0,
        },
        {
          systemPrompt: event.systemPrompt ?? "",
          prompt: event.prompt ?? "",
          historyMessages: Array.isArray(event.historyMessages) ? event.historyMessages : [],
        },
      );
    });
  }

  // Spread the settings rather than listing them. The list was written once and
  // then stopped being updated: recallPool, recallRerank and both score floors were
  // added and never appeared here, so a deployment running recall wide open looked
  // in the log exactly like one running it switched off, and the difference cost a
  // day to find. A key that exists in the config now names itself here.
  logger.info("plugin_loaded", {
    ...cfg,
    agents: Object.entries(cfg.agents).map(
      ([agentId, actors]) => `${agentId}:user=${actors.user}:assistant=${actors.assistant}`,
    ),
    captureMode: cfg.autoCapture ? "segmented_durable_fifo_v1" : "disabled",
    captureRuntime: captureOutcome,
    captureDurableQueue: Boolean(capture),
    captureRoot: capture?.durableRoot,
    captureLeasePath: capture?.captureLease.path,
    agentTools: cfg.agentTools && Boolean(api.registerTool),
    rawModelInputLogging:
      cfg.logModelInput && cfg.logOperations && cfg.logLevel === "debug" && cfg.logContent,
  });
}

export default { id, name, description, register };
