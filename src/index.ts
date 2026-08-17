import {
  BufferEngine,
  CHECK_INTERVAL_SEC,
  type AgentSink,
  type EpisodeIdentity,
  type EpisodeJson,
  type PersistedAgentCaptureState,
} from "./buffer.js";
import { acquireCaptureRuntime } from "./capture-runtime.js";
import { CaptureSpool, resolveCaptureSpoolPath, type CaptureSpoolState } from "./capture-spool.js";
import { DEFAULT_ACTORS, parseConfig, type GraphitiPluginConfig } from "./config.js";
import { EpisodeSequenceTracker } from "./episode-sequence.js";
import { PendingConfirmationTracker, sequenceKey } from "./pending-confirmation.js";
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
import { createGraphitiTools } from "./tools.js";
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

/** The host surface used for best-effort session status; replaced by the newest registration. */
type StatusHost = {
  patchSessionEntry?: NonNullable<
    NonNullable<NonNullable<OpenClawPluginApi["runtime"]>["agent"]>["session"]
  >["patchSessionEntry"];
};

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
  type CapturePipeline = {
    client: GraphitiMcpClient;
    transcriptDeltas: TranscriptDeltaTracker;
    captureSpool: CaptureSpool | undefined;
    engine: BufferEngine;
    statusHost: StatusHost;
    queueHealthTimer: ReturnType<typeof setInterval> | undefined;
    restoredCaptureState: CaptureSpoolState | undefined;
    lastSessionByAgent: Map<string, string>;
    unconfiguredAgentsReported: Set<string>;
  };

  // Built once per process. See capture-runtime.ts: one BufferEngine may own the
  // durable spool, or a restart with unsent messages hands the same buffer to
  // every registration and each one flushes it.
  const buildPipeline = (): CapturePipeline => {
    const client = new GraphitiMcpClient(cfg.baseUrl, cfg.requestTimeoutMs, (kind, body) => {
      logger.debugContent(
        kind === "request" ? "mcp_raw_request" : "mcp_raw_response",
        { baseUrl: cfg.baseUrl },
        { raw: body },
      );
    });
    const sequences = new EpisodeSequenceTracker();
    const pendingConfirmation = new PendingConfirmationTracker();
    const transcriptDeltas = new TranscriptDeltaTracker();
    const lastSessionByAgent = new Map<string, string>();
    const unconfiguredAgentsReported = new Set<string>();
    const backendReportedSessionByAgent = new Map<string, string>();
    const backendFingerprintByAgent = new Map<string, string>();

    const statusHost: StatusHost = {};
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
        pendingConfirmation.restore(restoredCaptureState.pending);
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
      const patchSessionEntry = statusHost.patchSessionEntry;
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

    /**
     * The batch number to continue from, never lower than one already issued.
     *
     * Graphiti's episode count reflects what it has *processed*, and processing
     * lags acceptance — by seconds when healthy, by half an hour when the model
     * is unreachable. Trusting it alone after a restart handed number 22 to a
     * second, different batch while the first was still in the queue, leaving one
     * dialog with two episodes of that name. What this process already issued is
     * on the confirmation ledger, and it survives the restart with it.
     */
    const resumeFrom = (
      agentId: string,
      sessionKey: string,
      saga: SagaState | undefined,
    ): { acceptedBatches: number; lastEpisodeUuid?: string } => {
      const fromBackend = saga?.episodeCount ?? 0;
      const issued = pendingConfirmation.highestIssued().get(sequenceKey(agentId, sessionKey)) ?? 0;
      if (issued <= fromBackend) {
        return { acceptedBatches: fromBackend, ...(saga?.lastEpisodeUuid ? { lastEpisodeUuid: saga.lastEpisodeUuid } : {}) };
      }
      logger.info("capture_sequence_ahead_of_backend", {
        agentId,
        group_id: agentId,
        saga: sessionKey,
        backendEpisodes: fromBackend,
        issued,
        action: "resumed_from_issued",
      });
      // The predecessor still comes from the backend: linking to an episode it has
      // not stored would produce an edge that silently fails to be created.
      return { acceptedBatches: issued, ...(saga?.lastEpisodeUuid ? { lastEpisodeUuid: saga.lastEpisodeUuid } : {}) };
    };

    const ensureSequenceHydrated = async (agentId: string, sessionKey: string): Promise<void> => {
      if (sequences.isHydrated(agentId, sessionKey)) return;

      const saga = await fetchSagaState(agentId, sessionKey);
      const resume = resumeFrom(agentId, sessionKey, saga);
      sequences.hydrate(agentId, sessionKey, resume.acceptedBatches, resume.lastEpisodeUuid);
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
      if (sequences.isHydrated(agentId, sessionKey)) {
        // This process already established the sequence for the session, so its
        // in-memory state is newer than anything get_saga can tell us.
        const state = sequences.snapshot(agentId, sessionKey);
        if (state.lastEpisodeUuid === identity.uuid) {
          logger.info("capture_replay_already_persisted", {
            agentId,
            group_id: agentId,
            saga: sessionKey,
            name: identity.name,
            batchNumber: identity.batchNumber,
            uuid: identity.uuid,
            action: "dropped_confirmed_batch",
            source: "in_memory_sequence",
          });
          return true;
        }
        return false;
      }

      const saga = await fetchSagaState(agentId, sessionKey);

      if (saga?.lastEpisodeUuid === identity.uuid) {
        // Graphiti holds this exact episode. Continue the chain from it instead of
        // creating a second episode with the same content.
        sequences.hydrate(agentId, sessionKey, identity.batchNumber, identity.uuid);
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

      // Same rule as the ordinary path: never resume below a number this process
      // already handed out, or the replayed batch collides with a live one.
      const resume = resumeFrom(agentId, sessionKey, saga);
      sequences.hydrate(agentId, sessionKey, resume.acceptedBatches, resume.lastEpisodeUuid);

      const reserved = {
        batchNumber: identity.batchNumber,
        episodeUuid: identity.uuid,
        name: identity.name,
        previousEpisodeUuids: identity.previousEpisodeUuid ? [identity.previousEpisodeUuid] : [],
        ...(identity.previousEpisodeUuid === undefined
          ? {}
          : { sagaPreviousEpisodeUuid: identity.previousEpisodeUuid }),
      };
      const adopted =
        sequences.snapshot(agentId, sessionKey).pending === undefined &&
        sequences.adoptPending(agentId, sessionKey, reserved);

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

      const episode: EpisodeJson = entry.buffer.episode;
      const jsonBody = JSON.stringify(episode);
      const sequence = sequences.prepare(agentId, sessionKey, jsonBody);
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

      // Accepted means handed over, not stored: Graphiti queues the batch and
      // extracts entities later, so the episode appears only once that finishes.
      // The batch stays on this ledger until it is seen in the graph.
      pendingConfirmation.track({
        agentId,
        sessionKey,
        uuid: episodeUuid,
        name: sequence.name,
        batchNumber: sequence.batchNumber,
        episodeBody: jsonBody,
        previousEpisodeUuids: sequence.previousEpisodeUuids,
      });
      engine.checkpoint();

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
                version: 3,
                agents: snapshot.agents,
                sessions: transcriptDeltas.export(),
                pending: pendingConfirmation.export(),
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

      // One poller per process, not one per registration.
      queueHealthTimer = setInterval(() => {
        void pollBackendQueueStatus();
      }, CHECK_INTERVAL_SEC * 1000);
      queueHealthTimer.unref?.();
    }


    return {
      client,
      transcriptDeltas,
      captureSpool,
      engine,
      statusHost,
      queueHealthTimer,
      restoredCaptureState,
      lastSessionByAgent,
      unconfiguredAgentsReported,
    };
  };

  const { runtime: pipeline, outcome } = acquireCaptureRuntime<CapturePipeline>({
    // The spool path is part of the runtime's identity: a pipeline owns one
    // durable file, so a different state directory is a different pipeline.
    fingerprint: JSON.stringify({ cfg, spool: resolveCaptureSpoolPath() }),
    isStopped: (candidate: CapturePipeline) => candidate.engine.isStopped(),
    create: buildPipeline,
  });
  // Session status is best effort and belongs to whichever host surface
  // registered most recently; the pipeline itself is shared.
  pipeline.statusHost.patchSessionEntry = api.runtime?.agent?.session?.patchSessionEntry;
  if (outcome !== "reused") logger.info("capture_pipeline", { outcome });

  const {
    client,
    transcriptDeltas,
    captureSpool,
    engine,
    restoredCaptureState,
    lastSessionByAgent,
    unconfiguredAgentsReported,
  } = pipeline;
  const queueHealthTimer = pipeline.queueHealthTimer;


  if (cfg.autoCapture) {
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

  if (cfg.agentTools && api.registerTool) {
    const tools = createGraphitiTools({
      cfg,
      client,
      logger,
      excludedSessionPatterns,
      // Only this process knows what has been captured but not yet submitted;
      // the backend cannot report a batch it has never seen.
      // A note goes through the same door as a message. The pipeline owns the
      // saga chain, so letting it do the writing is what keeps a note from
      // forking that chain; checkpointing afterwards puts the note in the spool
      // so a restart before the batch is committed does not lose it.
      captureNote: (agentId, sessionKey, note) => {
        engine.addMessages(agentId, sessionKey, [{ role: "assistant", text: note }]);
        engine.checkpoint();
      },
      localCaptureState: (agentId) => {
        const agent = engine.snapshot().agents.find((entry) => entry.agentId === agentId);
        const buffers = agent?.activeBuffers ?? [];
        const lastActivity = buffers.map((buffer) => buffer.lastActivityAt);
        return {
          bufferedMessages: buffers.reduce((sum, buffer) => sum + buffer.messages.length, 0),
          queuedBatches: agent?.queue.length ?? 0,
          ...(lastActivity.length > 0
            ? { oldestBufferAgeMs: Date.now() - Math.min(...lastActivity) }
            : {}),
          ...(captureSpool ? { spoolPath: captureSpool.path } : {}),
        };
      },
    });
    for (const tool of tools) {
      // Registered per invocation context so each call resolves its own agent
      // and session; the tool can never act on another agent's graph.
      api.registerTool((ctx) => ({ ...tool, execute: (id, params) => tool.execute(id, params, ctx) }), {
        name: tool.name,
      });
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

  // Opt-in on top of the content switches: this dumps the whole assembled
  // prompt, system instructions included, on every single run.
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

      // An agent missing from the config still gets captured, but under the
      // default actor names and without backend queue monitoring. Say so once
      // instead of letting a config typo change participant names silently.
      if (!cfg.agents[agentId] && !unconfiguredAgentsReported.has(agentId)) {
        unconfiguredAgentsReported.add(agentId);
        logger.warn("capture_agent_unconfigured", {
          agentId,
          group_id: agentId,
          configuredAgents: Object.keys(cfg.agents),
          participants: DEFAULT_ACTORS,
          backendQueueMonitoring: false,
        });
      }

      const snapshot = extractConversationMessages(Array.isArray(event.messages) ? event.messages : []);
      const delta = transcriptDeltas.take(agentId, sessionKey, snapshot);
      if (delta.length === 0) {
        // Nothing new to capture, but the session was observed this far. Commit
        // the watermark so a restart resumes here instead of guessing.
        transcriptDeltas.commit(agentId, sessionKey);
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

      try {
        engine.addMessages(agentId, sessionKey, delta);
      } catch (error) {
        // Buffering can only refuse after shutdown. Leaving the watermark where
        // it was means the next process observes these messages again rather
        // than treating them as captured.
        logger.warn("capture_skipped", {
          agentId,
          group_id: agentId,
          sessionKey,
          reason: "engine_rejected_messages",
          messages: delta.length,
          error: errorText(error),
          action: "watermark_not_advanced",
        });
        return;
      }

      // Observing is not capturing: the watermark only advances once the delta
      // is in the buffer, and the checkpoint that follows makes both durable.
      transcriptDeltas.commit(agentId, sessionKey);
      engine.checkpoint();
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
    agentTools: cfg.agentTools && Boolean(api.registerTool),
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
    rawModelInputLogging:
      cfg.logModelInput && cfg.logOperations && cfg.logLevel === "debug" && cfg.logContent,
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
