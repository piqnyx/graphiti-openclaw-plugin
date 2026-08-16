import {
  BufferEngine,
  CHECK_INTERVAL_SEC,
  type AgentSink,
  type EpisodeIdentity,
  type EpisodeJson,
  type PersistedAgentCaptureState,
} from "./buffer.js";
import { CaptureSpool, type CaptureSpoolState } from "./capture-spool.js";
import { parseConfig, type GraphitiPluginConfig } from "./config.js";
import { EpisodeSequenceTracker } from "./episode-sequence.js";
import { requireAgentId } from "./identity.js";
import { createGraphitiLogger } from "./logging.js";
import { compileSessionPatterns, matchSessionExclusion } from "./session-filter.js";
import { GraphitiMcpClient, OPENCLAW_SOURCE_DESCRIPTION, type SagaState } from "./mcp-client.js";
import {
  buildRecallBlockDetailed,
  buildRecallQuery,
  extractConversationMessages,
  sanitizeConversationText,
  SESSION_RESET_PROMPT_PREFIX,
} from "./text.js";
import { TranscriptDeltaTracker } from "./transcript-delta.js";
import type {
  AgentEndEvent,
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
  HookContext,
  LlmInputEvent,
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
const CAPTURE_SHUTDOWN_GRACE_MS = 4_000;
const GATEWAY_STOP_HOOK_TIMEOUT_MS = 4_500;

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

function captureSnapshotStats(snapshot: { agents: PersistedAgentCaptureState[] } | undefined): {
  agents: number;
  activeBuffers: number;
  queuedEntries: number;
  messages: number;
} {
  if (!snapshot) return { agents: 0, activeBuffers: 0, queuedEntries: 0, messages: 0 };
  let activeBuffers = 0;
  let queuedEntries = 0;
  let messages = 0;
  for (const agent of snapshot.agents) {
    activeBuffers += agent.activeBuffers.length;
    queuedEntries += agent.queue.length;
    messages += agent.activeBuffers.reduce((sum, buffer) => sum + buffer.messages.length, 0);
    messages += agent.queue.reduce((sum, entry) => sum + entry.buffer.messages.length, 0);
  }
  return { agents: snapshot.agents.length, activeBuffers, queuedEntries, messages };
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
  const client = new GraphitiMcpClient(cfg.baseUrl, cfg.requestTimeoutMs, (kind, body) => {
    logger.debugContent(
      kind === "request" ? "mcp_raw_request" : "mcp_raw_response",
      { baseUrl: cfg.baseUrl },
      { raw: body },
    );
  });
  const sequences = new EpisodeSequenceTracker();
  const transcriptDeltas = new TranscriptDeltaTracker();
  const hydratedSequences = new Set<string>();
  const lastSessionByAgent = new Map<string, string>();
  const backendReportedSessionByAgent = new Map<string, string>();
  const backendFingerprintByAgent = new Map<string, string>();

  const captureSpool = cfg.autoCapture ? new CaptureSpool() : undefined;
  let restoredCaptureState: CaptureSpoolState | undefined;
  let restoredWatermarks = 0;
  if (captureSpool) {
    try {
      restoredCaptureState = captureSpool.load();
    } catch (error) {
      logger.error("capture_spool_load_failed", {
        path: captureSpool.path,
        error: errorText(error),
        action: "startup_aborted_to_preserve_spool",
      });
      throw error;
    }
    if (restoredCaptureState) {
      restoredWatermarks = transcriptDeltas.restore(restoredCaptureState.sessions);
    }
    const restored = captureSnapshotStats(restoredCaptureState);
    if (restored.messages > 0 || restoredWatermarks > 0) {
      logger.info("capture_spool_restored", {
        path: captureSpool.path,
        ...restored,
        sessionWatermarks: restoredWatermarks,
      });
    }
  }

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

  const fetchSagaState = async (agentId: string, sessionKey: string): Promise<SagaState | undefined> => {
    const saga = await client.getSaga(sessionKey, agentId);
    if (!saga) return undefined;

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
    return saga;
  };

  const ensureSequenceHydrated = async (agentId: string, sessionKey: string): Promise<void> => {
    const key = sequenceKey(agentId, sessionKey);
    if (hydratedSequences.has(key)) return;

    const saga = await fetchSagaState(agentId, sessionKey);
    sequences.hydrate(agentId, sessionKey, saga?.episodeCount ?? 0, saga?.lastEpisodeUuid);
    hydratedSequences.add(key);
    logger.debug("capture_sequence_hydrated", {
      agentId,
      group_id: agentId,
      saga: sessionKey,
      episodeCount: saga?.episodeCount ?? 0,
      lastEpisodeUuid: saga?.lastEpisodeUuid,
      source: "graphiti",
    });
  };

  /**
   * A batch restored from the spool was already submitted once, and the answer to
   * that submission was lost with the previous process. Ask Graphiti which of the
   * two happened before doing anything else.
   *
   * Returns true when the batch is already persisted and must not be sent again.
   */
  const reconcileRestoredBatch = async (
    agentId: string,
    sessionKey: string,
    identity: EpisodeIdentity,
  ): Promise<boolean> => {
    const key = sequenceKey(agentId, sessionKey);
    const saga = await fetchSagaState(agentId, sessionKey);

    if (saga?.lastEpisodeUuid === identity.uuid) {
      // Graphiti holds this exact episode. Continue the chain from it instead of
      // creating a second episode with the same content.
      sequences.hydrate(agentId, sessionKey, identity.batchNumber, identity.uuid);
      hydratedSequences.add(key);
      logger.info("capture_replay_already_persisted", {
        agentId,
        group_id: agentId,
        saga: sessionKey,
        name: identity.name,
        batchNumber: identity.batchNumber,
        uuid: identity.uuid,
        action: "dropped_confirmed_batch",
      });
      return true;
    }

    sequences.hydrate(agentId, sessionKey, saga?.episodeCount ?? 0, saga?.lastEpisodeUuid);
    hydratedSequences.add(key);

    const adopted = sequences.adoptPending(agentId, sessionKey, {
      batchNumber: identity.batchNumber,
      episodeUuid: identity.uuid,
      name: identity.name,
      previousEpisodeUuids: identity.previousEpisodeUuid ? [identity.previousEpisodeUuid] : [],
      ...(identity.previousEpisodeUuid === undefined
        ? {}
        : { sagaPreviousEpisodeUuid: identity.previousEpisodeUuid }),
    });

    if (adopted) {
      logger.info("capture_replay_reserved_identity", {
        agentId,
        group_id: agentId,
        saga: sessionKey,
        name: identity.name,
        batchNumber: identity.batchNumber,
        uuid: identity.uuid,
        action: "retry_with_same_uuid",
      });
    } else {
      logger.warn("capture_replay_identity_diverged", {
        agentId,
        group_id: agentId,
        saga: sessionKey,
        reservedBatchNumber: identity.batchNumber,
        reservedUuid: identity.uuid,
        sagaEpisodeCount: saga?.episodeCount ?? 0,
        sagaLastEpisodeUuid: saga?.lastEpisodeUuid,
        action: "reserving_new_identity",
      });
    }
    return false;
  };

  const sink: AgentSink = async (agentId, entry, reason) => {
    const sessionKey = entry.buffer.sessionKey;

    if (entry.identityRestored && entry.episode) {
      const alreadyPersisted = await reconcileRestoredBatch(agentId, sessionKey, entry.episode);
      entry.identityRestored = false;
      // Returning without submitting reports the batch as delivered, which is
      // exactly right: Graphiti already has it.
      if (alreadyPersisted) return;
    }

    await ensureSequenceHydrated(agentId, sessionKey);

    const sequence = sequences.prepare(agentId, sessionKey);
    // Record what we are about to submit before submitting it. If the answer is
    // lost with the process, the next start knows which episode to ask about.
    entry.episode = {
      uuid: sequence.episodeUuid,
      name: sequence.name,
      batchNumber: sequence.batchNumber,
      ...(sequence.sagaPreviousEpisodeUuid === undefined
        ? {}
        : { previousEpisodeUuid: sequence.sagaPreviousEpisodeUuid }),
      submittedAt: Date.now(),
    };
    engine.checkpoint();

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
      initialState: restoredCaptureState,
      // Unaccepted batches and the transcript watermarks that describe how far
      // each session was already captured are one atomic durable unit.
      onStateChange: captureSpool
        ? (snapshot) =>
            captureSpool.save({
              version: 2,
              agents: snapshot.agents,
              sessions: transcriptDeltas.export(),
            })
        : undefined,
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
      notifyPersistError: (error) => {
        logger.error("capture_spool_write_failed", {
          path: captureSpool?.path,
          error: errorText(error),
          action: "kept_in_memory",
          durableReplayRequired: true,
        });
      },
      notifyPersistRecovered: () => {
        logger.info("capture_spool_write_recovered", { path: captureSpool?.path });
      },
    },
  );

  let queueHealthTimer: ReturnType<typeof setInterval> | undefined;
  if (cfg.autoCapture) {
    engine.resumeRestored();

    queueHealthTimer = setInterval(() => {
      void pollBackendQueueStatus();
    }, CHECK_INTERVAL_SEC * 1000);
    queueHealthTimer.unref?.();

    api.on(
      "gateway_stop",
      async () => {
        if (queueHealthTimer) clearInterval(queueHealthTimer);
        const before = captureSnapshotStats(engine.snapshot());
        logger.info("capture_shutdown_checkpoint", {
          path: captureSpool?.path,
          ...before,
          graceMs: CAPTURE_SHUTDOWN_GRACE_MS,
        });
        await engine.shutdown(CAPTURE_SHUTDOWN_GRACE_MS);
        const after = captureSnapshotStats(engine.snapshot());
        logger.info("capture_shutdown_complete", {
          path: captureSpool?.path,
          ...after,
          durableReplayRequired: after.messages > 0,
        });
      },
      { timeoutMs: GATEWAY_STOP_HOOK_TIMEOUT_MS },
    );
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

        // A session excluded from memory is excluded in both directions: it
        // neither writes to Graphiti nor receives injected memory from it.
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
          },
        );
        if (!query) {
          logger.debug("recall_skipped", { agentId, group_id: agentId, reason: "empty_query" });
          return;
        }

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

  if (cfg.logOperations && cfg.logLevel === "debug" && cfg.logContent) {
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

  if (cfg.autoCapture) {
    api.on("agent_end", (rawEvent: unknown, ctx?: HookContext): void => {
      const event = rawEvent as AgentEndEvent;
      const excluded = matchSessionExclusion(ctx ?? {}, excludedSessionPatterns);
      if (excluded) {
        logger.debug("capture_skipped", {
          agentId: ctx?.agentId,
          sessionKey: ctx?.sessionKey,
          trigger: ctx?.trigger,
          reason: "excluded_session",
          pattern: excluded.pattern,
          matched: excluded.matched,
        });
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

      const snapshot = extractConversationMessages(Array.isArray(event.messages) ? event.messages : []);
      const delta = transcriptDeltas.take(agentId, sessionKey, snapshot);
      if (delta.length === 0) {
        // The watermark moved even though nothing new was captured; persist it so
        // a restart resumes from the observed tail instead of guessing.
        engine.checkpoint();
        logger.debug("capture_skipped", {
          agentId,
          group_id: agentId,
          sessionKey,
          reason: "no_new_conversation_messages",
          eventSuccess: event.success,
          snapshotMessages: snapshot.length,
        });
        return;
      }

      const userMessages = delta.filter((message) => message.role === "user").length;
      const assistantMessages = delta.length - userMessages;
      logger.debugContent(
        "capture_messages",
        {
          agentId,
          group_id: agentId,
          sessionKey,
          messages: delta.length,
          userMessages,
          assistantMessages,
          eventSuccess: event.success,
          durationMs: event.durationMs,
        },
        { messages: delta },
      );

      engine.addMessages(agentId, sessionKey, delta);
    });
  }

  logger.info("plugin_loaded", {
    autoCapture: cfg.autoCapture,
    autoRecall: cfg.autoRecall,
    captureMode: "message_delta",
    bufferLimit: cfg.bufferLimit,
    bufferTimeout: cfg.bufferTimeout,
    captureDurableSpool: Boolean(captureSpool),
    captureSpoolPath: captureSpool?.path,
    excludeSessionPatterns: cfg.excludeSessionPatterns,
    restoredCaptureMessages: captureSnapshotStats(restoredCaptureState).messages,
    agents: Object.entries(cfg.agents).map(([agentId, actors]) =>
      `${agentId}:user=${actors.user}:assistant=${actors.assistant}`,
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
    rawModelInputLogging: cfg.logOperations && cfg.logLevel === "debug" && cfg.logContent,
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
