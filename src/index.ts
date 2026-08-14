import { BufferEngine, type AgentSink } from "./buffer.js";
import { parseConfig, type GraphitiPluginConfig } from "./config.js";
import { requireAgentId } from "./identity.js";
import { createGraphitiLogger } from "./logging.js";
import { GraphitiMcpClient } from "./mcp-client.js";
import {
  buildEpisodeJson,
  buildRecallBlock,
  compileAliasMatchers,
  extractCompletedTurn,
  prepareRecallQuery,
  SESSION_RESET_PROMPT_PREFIX,
  SLUG_GENERATOR_SESSION_KEY,
} from "./text.js";
import type {
  AgentEndEvent,
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
  HookContext,
  OpenClawPluginApi,
} from "./types.js";

export const id = "graphiti-openclaw-plugin";
export const name = "Graphiti Companion";
export const description =
  "Slot-less per-agent Graphiti auto-capture and auto-recall companion for OpenClaw";

function isBackgroundRun(ctx: HookContext): boolean {
  if (ctx.trigger === "cron" || ctx.trigger === "heartbeat") return true;
  const sessionKey = ctx.sessionKey ?? "";
  return sessionKey.includes(":cron:") || sessionKey.includes(":subagent:");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireSessionKey(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("missing OpenClaw ctx.sessionKey");
  }
  return value;
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
  const client = new GraphitiMcpClient(cfg.baseUrl, cfg.requestTimeoutMs);
  const aliasMatchers = compileAliasMatchers(cfg.participants);

  // Sink: из очереди-записи собираем JSON-эпизод и отправляем в Graphiti.
  // `agentId` подставляет движок при processинге (спека: agent = group_id).
  const sink: AgentSink = async (agentId, entry, reason) => {
    const episode = buildEpisodeJson(entry, cfg.participants, aliasMatchers);
    const jsonBody = JSON.stringify(episode);
    const referenceTime = new Date(entry.enqueuedAt).toISOString();

    logger.debug("capture_flush_start", {
      agentId,
      group_id: agentId,
      saga: entry.buffer.sessionKey,
      messages: entry.buffer.messages.length,
      reason,
      chars: jsonBody.length,
    });
    logger.debugContent(
      "capture_payload",
      {
        agentId,
        group_id: agentId,
        saga: entry.buffer.sessionKey,
        messages: entry.buffer.messages.length,
        reason,
        chars: jsonBody.length,
      },
      { episodeBody: jsonBody, source: "json", reference_time: referenceTime },
    );

    const started = Date.now();
    const result = await client.addMemory({
      name: `openclaw-${agentId}-${new Date().toISOString()}`,
      jsonBody,
      groupId: agentId,
      saga: entry.buffer.sessionKey,
      referenceTime,
    });
    if (typeof result.error === "string") throw new Error(result.error);

    logger.info("capture_queue_accepted", {
      agentId,
      group_id: agentId,
      saga: entry.buffer.sessionKey,
      messages: entry.buffer.messages.length,
      reason,
      durationMs: Date.now() - started,
    });
  };

  const engine = new BufferEngine(
    cfg.participants,
    cfg.bufferLimit,
    cfg.bufferTimeout,
    sink,
    {
      notifyError: (agentId, sessionKey, reason, error) =>
        logger.error("capture_flush_failed", {
          agentId,
          group_id: agentId,
          saga: sessionKey,
          reason,
          error: errorText(error),
          action: "dropped",
          automaticRetry: false,
          uiNotification: "not_implemented_todo",
        }),
    },
  );

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

        const query = prepareRecallQuery(event.prompt ?? "", cfg.recallQueryMaxChars);
        if (!query) {
          logger.debug("recall_skipped", { agentId, group_id: agentId, reason: "empty_query" });
          return;
        }
        if (query.startsWith(SESSION_RESET_PROMPT_PREFIX)) {
          logger.debug("recall_skipped", { agentId, group_id: agentId, reason: "session_reset" });
          return;
        }

        logger.debugContent(
          "recall_query",
          { agentId, group_id: agentId, chars: query.length },
          { query },
        );

        const started = Date.now();
        try {
          const facts = await client.searchFacts(query, agentId, cfg.recallLimit);
          const factTexts = facts
            .map((fact) => (typeof fact.fact === "string" ? fact.fact : ""))
            .filter(Boolean);
          const block = buildRecallBlock(factTexts, cfg.recallMaxInjectedChars);

          logger.debugContent(
            "recall_payload",
            {
              agentId,
              group_id: agentId,
              results: factTexts.length,
              injectedChars: block?.length ?? 0,
            },
            { facts: factTexts, injectedBlock: block ?? "" },
          );
          logger.info("recall_completed", {
            agentId,
            group_id: agentId,
            results: factTexts.length,
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

  if (cfg.autoCapture) {
    api.on("agent_end", (rawEvent: unknown, ctx?: HookContext): void => {
      const event = rawEvent as AgentEndEvent;
      if (!event.success) {
        logger.debug("capture_skipped", {
          agentId: ctx?.agentId,
          reason: "agent_run_failed",
          durationMs: event.durationMs,
        });
        return;
      }
      if (isBackgroundRun(ctx ?? {})) {
        logger.debug("capture_skipped", {
          agentId: ctx?.agentId,
          reason: "background_run",
          trigger: ctx?.trigger,
        });
        return;
      }
      if (ctx?.sessionKey === SLUG_GENERATOR_SESSION_KEY) {
        logger.debug("capture_skipped", { agentId: ctx?.agentId, reason: "slug_generator" });
        return;
      }

      let agentId: string;
      let sessionKey: string;
      try {
        agentId = requireAgentId(ctx?.agentId);
        sessionKey = requireSessionKey(ctx?.sessionKey);
      } catch (error) {
        logger.warn("capture_skipped", { reason: "missing_context_id", error: errorText(error) });
        return;
      }

      const turn = extractCompletedTurn(Array.isArray(event.messages) ? event.messages : []);
      if (!turn) {
        logger.debug("capture_skipped", {
          agentId,
          group_id: agentId,
          sessionKey,
          reason: "no_completed_turn",
          messageCount: Array.isArray(event.messages) ? event.messages.length : 0,
        });
        return;
      }

      logger.debugContent(
        "capture_turn",
        {
          agentId,
          group_id: agentId,
          sessionKey,
          userChars: turn.user.length,
          assistantChars: turn.assistant.length,
        },
        { user: turn.user, assistant: turn.assistant },
      );

      // Каждый завершённый ход = пара user+assistant → два сообщения в буфер.
      engine.addMessage(agentId, sessionKey, "user", turn.user);
      engine.addMessage(agentId, sessionKey, "assistant", turn.assistant);
    });
  }

  logger.info("plugin_loaded", {
    autoCapture: cfg.autoCapture,
    autoRecall: cfg.autoRecall,
    bufferLimit: cfg.bufferLimit,
    bufferTimeout: cfg.bufferTimeout,
    participants: cfg.participants.map((p) => `${p.role}:${p.name}`),
    requestTimeoutMs: cfg.requestTimeoutMs,
    recallLimit: cfg.recallLimit,
    logLevel: cfg.logLevel,
    logContent: cfg.logContent,
  });
}

export default { id, name, description, register };
