import { BufferEngine, CHECK_INTERVAL_SEC, type AgentSink, type EpisodeJson } from "./buffer.js";
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
  PluginJsonValue,
} from "./types.js";

export const id = "graphiti-openclaw-plugin";
export const name = "Graphiti Companion";
export const description =
  "Slot-less per-agent Graphiti auto-capture and auto-recall companion for OpenClaw";

const CAPTURE_STATUS_NAMESPACE = "capture-status";
const CAPTURE_STATUS_DESCRIPTOR_ID = "capture-error";
const BACKEND_STATUS_NAMESPACE = "backend-queue-status";
const BACKEND_STATUS_DESCRIPTOR_ID = "backend-queue-error";

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
  const lastSessionByAgent = new Map<string, string>();
  const backendReportedSessionByAgent = new Map<string, string>();
  const backendFingerprintByAgent = new Map<string, string>();

  api.session?.state?.registerSessionExtension({
    namespace: CAPTURE_STATUS_NAMESPACE,
    description: "Graphiti auto-capture transport error state for this OpenClaw session",
    project: ({ state }) => state,
  });
  api.session?.state?.registerSessionExtension({
    namespace: BACKEND_STATUS_NAMESPACE,
    description: "Graphiti asynchronous backend queue error state for this OpenClaw session",
    project: ({ state }) => state,
  });
  api.session?.controls?.registerControlUiDescriptor({
    id: CAPTURE_STATUS_DESCRIPTOR_ID,
    surface: "session",
    label: "Graphiti capture",
    description: "Shows Graphiti capture transport failures for the current session",
    schema: {
      type: "object",
      properties: {
        status: { const: "error" },
        message: { type: "string" },
        error: { type: "string" },
        reason: { enum: ["limit", "timeout"] },
        retryIntervalSeconds: { type: "integer" },
        occurredAt: { type: "string" },
      },
      required: ["status", "message", "reason", "retryIntervalSeconds", "occurredAt"],
    },
  });
  api.session?.controls?.registerControlUiDescriptor({
    id: BACKEND_STATUS_DESCRIPTOR_ID,
    surface: "session",
    label: "Graphiti backend",
    description: "Shows terminal Graphiti backend processing or health failures",
    schema: {
      type: "object",
      properties: {
        status: { const: "error" },
        source: { enum: ["backend_queue", "backend_health"] },
        message: { type: "string" },
        error: { type: "string" },
        attempts: { type: "integer" },
        pending: { type: "integer" },
        episodeUuid: { type: "string" },
        episodeName: { type: "string" },
        occurredAt: { type: "string" },
      },
      required: ["status", "source", "message", "occurredAt"],
    },
  });

  const patchSessionStatus = async (
    agentId: string,
    sessionKey: string,
    namespace: string,
    value: PluginJsonValue | undefined,
  ): Promise<void> => {
    const patchSessionEntry = api.runtime?.agent?.session?.patchSessionEntry;
    if (!patchSessionEntry || !sessionKey || agentId === "__tick__") return;

    await patchSessionEntry({
      agentId,
      sessionKey,
      preserveActivity: true,
      update: (entry) => {
        const pluginExtensions = { ...(entry.pluginExtensions ?? {}) };
        const pluginState = { ...(pluginExtensions[id] ?? {}) };
        if (value === undefined) {
          delete pluginState[namespace];
        } else {
          pluginState[namespace] = value;
        }
        if (Object.keys(pluginState).length > 0) {
          pluginExtensions[id] = pluginState;
        } else {
          delete pluginExtensions[id];
        }
        return {
          pluginExtensions:
            Object.keys(pluginExtensions).length > 0 ? pluginExtensions : undefined,
        };
      },
    });
  };

  const publishCaptureError = (
    agentId: string,
    sessionKey: string,
    reason: "limit" | "timeout",
    error: Error,
  ): void => {
    const value: PluginJsonValue = {
      status: "error",
      message: "Graphiti capture failed; batch retained for automatic retry",
      error: errorText(error),
      reason,
      retryIntervalSeconds: CHECK_INTERVAL_SEC,
      occurredAt: new Date().toISOString(),
    };
    void patchSessionStatus(agentId, sessionKey, CAPTURE_STATUS_NAMESPACE, value).catch(
      (statusError) => {
        logger.warn("capture_ui_status_failed", {
          agentId,
          group_id: agentId,
          saga: sessionKey,
          action: "publish_error",
          error: errorText(statusError),
        });
      },
    );
  };

  const clearCaptureError = (agentId: string, sessionKey: string): void => {
    void patchSessionStatus(agentId, sessionKey, CAPTURE_STATUS_NAMESPACE, undefined).catch(
      (statusError) => {
        logger.warn("capture_ui_status_failed", {
          agentId,
          group_id: agentId,
          saga: sessionKey,
          action: "clear_recovered_error",
          error: errorText(statusError),
        });
      },
    );
  };

  const publishBackendError = (
    agentId: string,
    sessionKey: string,
    value: PluginJsonValue,
  ): void => {
    void patchSessionStatus(agentId, sessionKey, BACKEND_STATUS_NAMESPACE, value).catch(
      (statusError) => {
        logger.warn("capture_ui_status_failed", {
          agentId,
          group_id: agentId,
          saga: sessionKey,
          action: "publish_backend_error",
          error: errorText(statusError),
        });
      },
    );
  };

  const clearBackendError = (agentId: string, sessionKey: string): void => {
    void patchSessionStatus(agentId, sessionKey, BACKEND_STATUS_NAMESPACE, undefined).catch(
      (statusError) => {
        logger.warn("capture_ui_status_failed", {
          agentId,
          group_id: agentId,
          saga: sessionKey,
          action: "clear_backend_error",
          error: errorText(statusError),
        });
      },
    );
  };

  const pollBackendQueueStatus = async (): Promise<void> => {
    for (const agentId of Object.keys(cfg.agents)) {
      try {
        const status = await client.getQueueStatus(agentId);
        if (status.groupId !== agentId) {
          throw new Error(
            `Graphiti get_queue_status identity mismatch: requested ${agentId}, got ${status.groupId}`,
          );
        }

        if (status.blocked) {
          const sessionKey = status.saga ?? lastSessionByAgent.get(agentId);
          const fingerprint = `blocked:${status.episodeUuid ?? ""}:${status.attempts}:${status.lastError ?? ""}`;
          const previousSession = backendReportedSessionByAgent.get(agentId);
          if (previousSession && sessionKey && previousSession !== sessionKey) {
            clearBackendError(agentId, previousSession);
          }

          if (sessionKey && backendFingerprintByAgent.get(agentId) !== fingerprint) {
            publishBackendError(agentId, sessionKey, {
              status: "error",
              source: "backend_queue",
              message: `Graphiti backend queue is blocked after ${status.attempts} failed attempts; memory persistence for this agent is stopped`,
              error: status.lastError ?? "unknown backend processing error",
              attempts: status.attempts,
              pending: status.pending,
              episodeUuid: status.episodeUuid ?? "",
              episodeName: status.episodeName ?? "",
              occurredAt: new Date().toISOString(),
            });
            backendReportedSessionByAgent.set(agentId, sessionKey);
            backendFingerprintByAgent.set(agentId, fingerprint);
            logger.error("capture_backend_blocked", {
              agentId,
              group_id: agentId,
              saga: sessionKey,
              uuid: status.episodeUuid,
              name: status.episodeName,
              attempts: status.attempts,
              pending: status.pending,
              error: status.lastError,
              uiNotification: "session_status",
            });
          }
          continue;
        }

        const previousSession = backendReportedSessionByAgent.get(agentId);
        if (previousSession) {
          clearBackendError(agentId, previousSession);
          logger.info("capture_backend_recovered", {
            agentId,
            group_id: agentId,
            saga: previousSession,
          });
        }
        backendReportedSessionByAgent.delete(agentId);
        backendFingerprintByAgent.delete(agentId);
      } catch (error) {
        const previousFingerprint = backendFingerprintByAgent.get(agentId);
        if (previousFingerprint?.startsWith("blocked:")) {
          logger.warn("capture_backend_healthcheck_failed", {
            agentId,
            group_id: agentId,
            error: errorText(error),
            preservedStatus: "backend_queue_blocked",
          });
          continue;
        }

        const sessionKey = lastSessionByAgent.get(agentId);
        const fingerprint = `health:${errorText(error)}`;
        if (sessionKey && previousFingerprint !== fingerprint) {
          publishBackendError(agentId, sessionKey, {
            status: "error",
            source: "backend_health",
            message: "Graphiti backend health check failed; memory persistence cannot be verified",
            error: errorText(error),
            occurredAt: new Date().toISOString(),
          });
          backendReportedSessionByAgent.set(agentId, sessionKey);
          backendFingerprintByAgent.set(agentId, fingerprint);
          logger.error("capture_backend_healthcheck_failed", {
            agentId,
            group_id: agentId,
            saga: sessionKey,
            error: errorText(error),
            uiNotification: "session_status",
          });
        }
      }
    }
  };

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
      notifyError: (agentId, sessionKey, reason, error) => {
        logger.error("capture_flush_failed", {
          agentId,
          group_id: agentId,
          saga: sessionKey,
          reason,
          error: errorText(error),
          action: "retained_for_retry",
          automaticRetry: true,
          retryIntervalSeconds: CHECK_INTERVAL_SEC,
          uiNotification: "session_status",
        });
        publishCaptureError(agentId, sessionKey, reason, error);
      },
      notifyRecovered: (agentId, sessionKey, reason) => {
        logger.info("capture_flush_recovered", {
          agentId,
          group_id: agentId,
          saga: sessionKey,
          reason,
        });
        clearCaptureError(agentId, sessionKey);
      },
    },
  );

  let queueHealthTimer: ReturnType<typeof setInterval> | undefined;
  if (cfg.autoCapture) {
    queueHealthTimer = setInterval(() => {
      void pollBackendQueueStatus();
    }, CHECK_INTERVAL_SEC * 1000);
    queueHealthTimer.unref?.();

    api.on("gateway_stop", () => {
      if (queueHealthTimer) clearInterval(queueHealthTimer);
      engine.stop();
    });
  }

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

      lastSessionByAgent.set(agentId, sessionKey);

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
    captureErrorUiStatus: Boolean(
      api.session?.state?.registerSessionExtension &&
        api.session?.controls?.registerControlUiDescriptor &&
        api.runtime?.agent?.session?.patchSessionEntry,
    ),
    backendQueueHealthPolling: cfg.autoCapture,
    backendQueueHealthIntervalSeconds: CHECK_INTERVAL_SEC,
  });
}

export default { id, name, description, register };
