import {
  createCapturePipeline,
  resolveDurableCaptureRoot,
  type CapturePipeline,
} from "./capture-pipeline.js";
import { acquireCaptureRuntime } from "./capture-runtime.js";
import { parseConfig, type GraphitiPluginConfig } from "./config.js";
import { requireAgentId } from "./identity.js";
import { createGraphitiLogger } from "./logging.js";
import { compileSessionPatterns, matchSessionExclusion } from "./session-filter.js";
import { GraphitiMcpClient } from "./mcp-client.js";
import {
  buildRecallBlockDetailed,
  buildRecallQuery,
  sanitizeConversationText,
  SESSION_RESET_PROMPT_PREFIX,
} from "./text.js";
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

  if (cfg.autoCapture) {
    const acquired = acquireCaptureRuntime<CapturePipeline>({
      fingerprint: JSON.stringify({ cfg, durableRoot: resolveDurableCaptureRoot() }),
      isStopped: (candidate) => candidate.engine.isStopped(),
      create: () => createCapturePipeline({ api, cfg, logger, excludedSessionPatterns }),
    });
    capture = acquired.runtime;
    captureOutcome = acquired.outcome;
    client = capture.client;
    capture.statusHost.patchSessionEntry = api.runtime?.agent?.session?.patchSessionEntry;

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
        if (!capture) throw new Error("Graphiti auto-capture is disabled; notes cannot be durably queued");
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

        const query = buildRecallQuery(
          currentPrompt,
          Array.isArray(event.messages) ? event.messages : [],
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
          const facts = await client.searchFacts(query, agentId, cfg.recallLimit);
          const factTexts = facts
            .map((fact) => (typeof fact.fact === "string" ? fact.fact : ""))
            .filter(Boolean);
          const recallBlock = buildRecallBlockDetailed(factTexts, cfg.recallMaxInjectedChars);
          const block = recallBlock.block;
          logger.debugContent(
            "recall_payload",
            {
              agentId,
              group_id: agentId,
              retrievedFacts: factTexts.length,
              injectedFacts: recallBlock.injectedFacts,
              skippedFacts: recallBlock.skippedFacts,
              recallLimit: cfg.recallLimit,
              maxInjectedChars: cfg.recallMaxInjectedChars,
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

  logger.info("plugin_loaded", {
    autoCapture: cfg.autoCapture,
    autoRecall: cfg.autoRecall,
    captureMode: cfg.autoCapture ? "segmented_durable_fifo_v1" : "disabled",
    captureRuntime: captureOutcome,
    bufferLimit: cfg.bufferLimit,
    bufferTimeout: cfg.bufferTimeout,
    captureDurableQueue: Boolean(capture),
    captureRoot: capture?.durableRoot,
    captureLeasePath: capture?.captureLease.path,
    excludeSessionPatterns: cfg.excludeSessionPatterns,
    agentTools: cfg.agentTools && Boolean(api.registerTool),
    agents: Object.entries(cfg.agents).map(
      ([agentId, actors]) => `${agentId}:user=${actors.user}:assistant=${actors.assistant}`,
    ),
    requestTimeoutMs: cfg.requestTimeoutMs,
    recallLimit: cfg.recallLimit,
    recallQueryMaxChars: cfg.recallQueryMaxChars,
    recallMaxInjectedChars: cfg.recallMaxInjectedChars,
    recallUseHistory: cfg.recallUseHistory,
    recallHistoryMaxMessages: cfg.recallHistoryMaxMessages,
    recallHistoryMaxChars: cfg.recallHistoryMaxChars,
    logLevel: cfg.logLevel,
    logContent: cfg.logContent,
    rawModelInputLogging:
      cfg.logModelInput && cfg.logOperations && cfg.logLevel === "debug" && cfg.logContent,
  });
}

export default { id, name, description, register };
