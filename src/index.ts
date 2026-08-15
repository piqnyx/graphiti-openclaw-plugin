import { BufferEngine, type AgentSink, type EpisodeJson } from "./buffer.js";
import { parseConfig, type GraphitiPluginConfig } from "./config.js";
import { EpisodeSequenceTracker } from "./episode-sequence.js";
import { requireAgentId } from "./identity.js";
import { createGraphitiLogger } from "./logging.js";
import { GraphitiMcpClient, OPENCLAW_SOURCE_DESCRIPTION } from "./mcp-client.js";
import {
  buildRecallBlock,
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
  return (
    sessionKey.includes(":cron:") ||
    sessionKey.includes(":heartbeat:") ||
    sessionKey.includes(":subagent:")
  );
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

function acceptedEpisodeUuid(result: Record<string, unknown>): string {
  if (typeof result.error === "string") throw new Error(result.error);
  if (typeof result.uuid !== "string" || result.uuid.trim() === "") {
    throw new Error("Graphiti add_memory accepted response did not contain episode uuid");
  }
  return result.uuid;
}

function sequenceKey(agentId: string, sessionKey: string): string {
  return JSON.stringify([agentId, sessionKey]);
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
  const client = new GraphitiMcpClient(cfg.baseUrl, cfg.requestTimeoutMs, (kind, body) => {
    logger.debugContent(
      kind === "request" ? "mcp_raw_request" : "mcp_raw_response",
      { baseUrl: cfg.baseUrl },
      { raw: body },
    );
  });
  const sequences = new EpisodeSequenceTracker();
  const hydratedSequences = new Set<string>();

  const ensureSequenceHydrated = async (agentId: string, sessionKey: string): Promise<void> => {
    const key = sequenceKey(agentId, sessionKey);
    if (hydratedSequences.has(key)) return;

    const saga = await client.getSaga(sessionKey, agentId);
    if (!saga) {
      sequences.hydrate(agentId, sessionKey, 0);
      hydratedSequences.add(key);
      logger.debug("capture_sequence_hydrated", {
        agentId,
        group_id: agentId,
        saga: sessionKey,
        episodeCount: 0,
        source: "graphiti",
      });
      return;
    }

    if (saga.groupId !== agentId || saga.name !== sessionKey) {
      throw new Error(
        `Graphiti get_saga identity mismatch: requested ${agentId}/${sessionKey}, got ${saga.groupId}/${saga.name}`,
      );
    }
    if (saga.episodeCount > 0 && !saga.lastEpisodeUuid) {
      throw new Error(
        `Graphiti saga ${agentId}/${sessionKey} has ${saga.episodeCount} episodes but no last_episode_uuid`,
      );
    }

    sequences.hydrate(agentId, sessionKey, saga.episodeCount, saga.lastEpisodeUuid);
    hydratedSequences.add(key);
    logger.debug("capture_sequence_hydrated", {
      agentId,
      group_id: agentId,
      saga: sessionKey,
      episodeCount: saga.episodeCount,
      lastEpisodeUuid: saga.lastEpisodeUuid,
      source: "graphiti",
    });
  };

  const sink: AgentSink = async (agentId, entry, reason) => {
    const sessionKey = entry.buffer.sessionKey;
    await ensureSequenceHydrated(agentId, sessionKey);

    const sequence = sequences.prepare(agentId, sessionKey);
    const episode: EpisodeJson = entry.buffer.episode;
    const jsonBody = JSON.stringify(episode);
    const referenceTime = new Date(entry.enqueuedAt).toISOString();

    logger.debug("capture_flush_start", {
      agentId,
      group_id: agentId,
      saga: sessionKey,
      name: sequence.name,
      batchNumber: sequence.batchNumber,
      uuid: sequence.episodeUuid,
      previousEpisodeUuid: sequence.sagaPreviousEpisodeUuid,
      messages: entry.buffer.messages.length,
      reason,
      chars: jsonBody.length,
      reference_time: referenceTime,
    });
    logger.debugContent(
      "capture_payload",
      {
        agentId,
        group_id: agentId,
        saga: sessionKey,
        name: sequence.name,
        batchNumber: sequence.batchNumber,
        uuid: sequence.episodeUuid,
        messages: entry.buffer.messages.length,
        reason,
        chars: jsonBody.length,
      },
      {
        episodeBody: jsonBody,
        source: "json",
        source_description: OPENCLAW_SOURCE_DESCRIPTION,
        reference_time: referenceTime,
        previous_episode_uuids: sequence.previousEpisodeUuids,
      },
    );

    const started = Date.now();
    const result = await client.addMemory({
      uuid: sequence.episodeUuid,
      name: sequence.name,
      jsonBody,
      groupId: agentId,
      saga: sessionKey,
      referenceTime,
      previousEpisodeUuids: sequence.previousEpisodeUuids,
      sagaPreviousEpisodeUuid: sequence.sagaPreviousEpisodeUuid,
    });

    logger.debugContent(
      "capture_mcp_response",
      {
        agentId,
        group_id: agentId,
        saga: sessionKey,
        name: sequence.name,
        batchNumber: sequence.batchNumber,
        uuid: sequence.episodeUuid,
        messages: entry.buffer.messages.length,
        durationMs: Date.now() - started,
      },
      { mcpResult: JSON.stringify(result) },
    );

    const episodeUuid = acceptedEpisodeUuid(result);
    sequences.accept(agentId, sessionKey, sequence.batchNumber, episodeUuid);

    logger.info("capture_queue_accepted", {
      agentId,
      group_id: agentId,
      saga: sessionKey,
      name: sequence.name,
      batchNumber: sequence.batchNumber,
      uuid: episodeUuid,
      previousEpisodeUuid: sequence.sagaPreviousEpisodeUuid,
      messages: entry.buffer.messages.length,
      reason,
      durationMs: Date.now() - started,
    });
  };

  const engine = new BufferEngine(
    cfg.agents,
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
          action: "retained_for_retry",
          automaticRetry: true,
          retryIntervalSeconds: 30,
          uiNotification: "pending_host_integration",
        }),
      notifyRecovered: (agentId, sessionKey, reason) =>
        logger.info("capture_flush_recovered", {
          agentId,
          group_id: agentId,
          saga: sessionKey,
          reason,
        }),
    },
  );

  // Recall remains intentionally unchanged while capture is being stabilized.
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
          sessionKey: ctx?.sessionKey,
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

      engine.addTurn(agentId, sessionKey, turn.user, turn.assistant);
    });
  }

  logger.info("plugin_loaded", {
    autoCapture: cfg.autoCapture,
    autoRecall: cfg.autoRecall,
    bufferLimit: cfg.bufferLimit,
    bufferTimeout: cfg.bufferTimeout,
    agents: Object.entries(cfg.agents).map(([agentId, actors]) =>
      `${agentId}:user=${actors.user}:assistant=${actors.assistant}`,
    ),
    requestTimeoutMs: cfg.requestTimeoutMs,
    recallLimit: cfg.recallLimit,
    logLevel: cfg.logLevel,
    logContent: cfg.logContent,
  });
}

export default { id, name, description, register };
