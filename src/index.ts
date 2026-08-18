import {
  BufferEngine,
  CHECK_INTERVAL_SEC,
  type AgentSink,
  type EpisodeIdentity,
  type EpisodeJson,
  type PersistedAgentCaptureState,
} from "./buffer.js";
import { CaptureLease } from "./capture-lease.js";
import { acquireCaptureRuntime } from "./capture-runtime.js";
import { CaptureSpool, resolveCaptureSpoolPath, type CaptureSpoolState } from "./capture-spool.js";
import { DEFAULT_ACTORS, parseConfig, type GraphitiPluginConfig } from "./config.js";
import { deriveEpisodeUuid, episodeNamePrefix, EpisodeSequenceTracker } from "./episode-sequence.js";
import { requireAgentId } from "./identity.js";
import { createGraphitiLogger } from "./logging.js";
import { compileSessionPatterns, matchSessionExclusion } from "./session-filter.js";
import { GraphitiMcpClient, OPENCLAW_SOURCE_DESCRIPTION, type QueueStatus, type SagaState } from "./mcp-client.js";
import {
  buildRecallBlockDetailed,
  buildRecallQuery,
  extractConversationMessages,
  sanitizeConversationText,
  SESSION_RESET_PROMPT_PREFIX,
} from "./text.js";
import { createGraphitiTools } from "./tools.js";
import { TranscriptCursorError, TranscriptDeltaTracker } from "./transcript-delta.js";
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

type CaptureFailureReason = "limit" | "timeout" | "cursor" | "durability";

type StatusHost = {
  patchSessionEntry?: NonNullable<
    NonNullable<NonNullable<OpenClawPluginApi["runtime"]>["agent"]>["session"]
  >["patchSessionEntry"];
};

type CapturePipeline = {
  client: GraphitiMcpClient;
  transcriptDeltas: TranscriptDeltaTracker;
  captureSpool: CaptureSpool | undefined;
  captureLease: CaptureLease | undefined;
  engine: BufferEngine;
  statusHost: StatusHost;
  queueHealthTimer: ReturnType<typeof setInterval> | undefined;
  restoredCaptureState: CaptureSpoolState | undefined;
  lastSessionByAgent: Map<string, string>;
  unconfiguredAgentsReported: Set<string>;
  lastQueueStatusByAgent: Map<string, QueueStatus>;
};

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
  if (result.persisted !== true) {
    throw new Error("Graphiti delivery returned before the episode was proven committed");
  }
  if (typeof result.uuid !== "string" || result.uuid.trim() === "") {
    throw new Error("Graphiti committed response did not contain episode uuid");
  }
  return result.uuid;
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

function expectedEpisodeName(sessionKey: string, batchNumber: number): string {
  return `${episodeNamePrefix(sessionKey)}-${batchNumber}`;
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

  const buildPipeline = (): CapturePipeline => {
    const client = new GraphitiMcpClient(cfg.baseUrl, cfg.requestTimeoutMs, (kind, body) => {
      logger.debugContent(
        kind === "request" ? "mcp_raw_request" : "mcp_raw_response",
        { baseUrl: cfg.baseUrl },
        { raw: body },
      );
    });
    const sequences = new EpisodeSequenceTracker();
    const transcriptDeltas = new TranscriptDeltaTracker();
    const lastSessionByAgent = new Map<string, string>();
    const unconfiguredAgentsReported = new Set<string>();
    const backendReportedSessionByAgent = new Map<string, string>();
    const backendFingerprintByAgent = new Map<string, string>();
    const lastQueueStatusByAgent = new Map<string, QueueStatus>();
    const statusHost: StatusHost = {};

    const captureSpool = cfg.autoCapture ? new CaptureSpool() : undefined;
    const captureLease = captureSpool ? new CaptureLease(captureSpool.path) : undefined;
    let restoredCaptureState: CaptureSpoolState | undefined;
    let engine!: BufferEngine;
    let queueHealthTimer: ReturnType<typeof setInterval> | undefined;

    try {
      if (captureLease) {
        captureLease.acquire();
        logger.info("capture_spool_lease_acquired", {
          path: captureLease.path,
          pid: process.pid,
        });
      }

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
        description: "Graphiti durable capture error state for this OpenClaw session",
        project: ({ state }) => state,
      });
      api.session?.state?.registerSessionExtension({
        namespace: BACKEND_STATUS_NAMESPACE,
        description: "Graphiti asynchronous backend processing error state for this OpenClaw session",
        project: ({ state }) => state,
      });
      api.session?.controls?.registerControlUiDescriptor({
        id: CAPTURE_STATUS_DESCRIPTOR_ID,
        surface: "session",
        label: "Graphiti capture",
        description: "Shows durable capture or transcript cursor failures for the current session",
        schema: {
          type: "object",
          properties: {
            status: { const: "error" },
            message: { type: "string" },
            error: { type: "string" },
            reason: { enum: ["limit", "timeout", "cursor", "durability"] },
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
        description: "Shows provider/backend retries or health failures",
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
            if (value === undefined) delete pluginState[namespace];
            else pluginState[namespace] = value;
            if (Object.keys(pluginState).length > 0) pluginExtensions[id] = pluginState;
            else delete pluginExtensions[id];
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
        reason: CaptureFailureReason,
        error: Error,
      ): void => {
        const value: PluginJsonValue = {
          status: "error",
          message:
            reason === "cursor"
              ? "Graphiti capture stopped for this session because transcript position is ambiguous"
              : reason === "durability"
                ? "Graphiti capture cannot make a durable checkpoint; remote delivery is stopped"
                : "Graphiti capture failed; durable FIFO head retained for automatic retry",
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
              action: "clear_capture_error",
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

      const fetchSagaState = async (
        agentId: string,
        sessionKey: string,
      ): Promise<SagaState | undefined> => {
        const saga = await client.getSaga(sessionKey, agentId);
        if (!saga) return undefined;
        if (saga.groupId !== agentId || saga.name !== sessionKey) {
          throw new Error(
            `Graphiti get_saga identity mismatch: requested ${agentId}/${sessionKey}, got ${saga.groupId}/${saga.name}`,
          );
        }
        if (!saga.integrityOk || saga.chainCount !== saga.episodeCount) {
          throw new Error(
            `Graphiti saga ${agentId}/${sessionKey} is structurally invalid: ${saga.integrityErrors.join("; ") || "chain count mismatch"}`,
          );
        }
        if (saga.episodeCount > 0 && (!saga.firstEpisodeUuid || !saga.lastEpisodeUuid)) {
          throw new Error(
            `Graphiti saga ${agentId}/${sessionKey} has ${saga.episodeCount} episodes but incomplete first/last pointers`,
          );
        }
        return saga;
      };

      const ensureSequenceHydrated = async (agentId: string, sessionKey: string): Promise<void> => {
        if (sequences.isHydrated(agentId, sessionKey)) return;
        const saga = await fetchSagaState(agentId, sessionKey);
        sequences.hydrate(
          agentId,
          sessionKey,
          saga?.episodeCount ?? 0,
          saga?.lastEpisodeUuid,
        );
        logger.debug("capture_sequence_hydrated", {
          agentId,
          group_id: agentId,
          saga: sessionKey,
          episodeCount: saga?.episodeCount ?? 0,
          lastEpisodeUuid: saga?.lastEpisodeUuid,
          integrity: saga?.integrityOk ?? true,
        });
      };

      const reconcileRestoredIdentity = async (
        agentId: string,
        sessionKey: string,
        identity: EpisodeIdentity,
        jsonBody: string,
      ): Promise<boolean> => {
        const expectedName = expectedEpisodeName(sessionKey, identity.batchNumber);
        if (identity.name !== expectedName) {
          throw new Error(
            `restored capture identity name mismatch for ${agentId}/${sessionKey}: expected ${expectedName}, got ${identity.name}`,
          );
        }
        const expectedUuid = deriveEpisodeUuid(agentId, sessionKey, identity.batchNumber, jsonBody);
        if (identity.uuid !== expectedUuid) {
          throw new Error(
            `restored capture identity/body mismatch for ${agentId}/${sessionKey} batch ${identity.batchNumber}; refusing to mint or reuse a different episode`,
          );
        }

        const saga = await fetchSagaState(agentId, sessionKey);
        if (saga?.lastEpisodeUuid === identity.uuid) {
          if (saga.episodeCount !== identity.batchNumber) {
            throw new Error(
              `restored batch ${identity.name} is Saga tail but Saga count is ${saga.episodeCount}; expected ${identity.batchNumber}`,
            );
          }
          sequences.hydrate(agentId, sessionKey, identity.batchNumber, identity.uuid);
          logger.info("capture_replay_already_committed", {
            agentId,
            group_id: agentId,
            saga: sessionKey,
            name: identity.name,
            batchNumber: identity.batchNumber,
            uuid: identity.uuid,
            action: "remove_durable_head_without_resubmission",
          });
          return true;
        }

        const predecessorCount = identity.batchNumber - 1;
        if ((saga?.episodeCount ?? 0) !== predecessorCount) {
          throw new Error(
            `restored batch ${identity.name} expects committed predecessor count ${predecessorCount}, but Saga has ${saga?.episodeCount ?? 0}; refusing chronology guess`,
          );
        }
        if (predecessorCount === 0) {
          if (identity.previousEpisodeUuid !== undefined) {
            throw new Error(`first restored batch ${identity.name} unexpectedly has a predecessor UUID`);
          }
          sequences.hydrate(agentId, sessionKey, 0);
        } else {
          if (!identity.previousEpisodeUuid) {
            throw new Error(`restored batch ${identity.name} is missing its predecessor UUID`);
          }
          if (saga?.lastEpisodeUuid !== identity.previousEpisodeUuid) {
            throw new Error(
              `restored batch ${identity.name} predecessor mismatch: durable=${identity.previousEpisodeUuid}, graph=${saga?.lastEpisodeUuid ?? "none"}`,
            );
          }
          sequences.hydrate(agentId, sessionKey, predecessorCount, identity.previousEpisodeUuid);
        }

        const adopted = sequences.adoptPending(agentId, sessionKey, {
          batchNumber: identity.batchNumber,
          episodeUuid: identity.uuid,
          name: identity.name,
          previousEpisodeUuids: identity.previousEpisodeUuid ? [identity.previousEpisodeUuid] : [],
          ...(identity.previousEpisodeUuid
            ? { sagaPreviousEpisodeUuid: identity.previousEpisodeUuid }
            : {}),
        });
        if (!adopted) {
          throw new Error(
            `could not re-adopt durable identity ${identity.name}; refusing to reserve a replacement identity`,
          );
        }
        logger.info("capture_replay_identity_adopted", {
          agentId,
          group_id: agentId,
          saga: sessionKey,
          name: identity.name,
          batchNumber: identity.batchNumber,
          uuid: identity.uuid,
        });
        return false;
      };

      const sink: AgentSink = async (agentId, entry, reason) => {
        const sessionKey = entry.buffer.sessionKey;
        const episode: EpisodeJson = entry.buffer.episode;
        const jsonBody = JSON.stringify(episode);

        if (entry.identityRestored && entry.episode) {
          const alreadyCommitted = await reconcileRestoredIdentity(
            agentId,
            sessionKey,
            entry.episode,
            jsonBody,
          );
          entry.identityRestored = false;
          if (alreadyCommitted) return;
        } else {
          await ensureSequenceHydrated(agentId, sessionKey);
        }

        const sequence = sequences.prepare(agentId, sessionKey, jsonBody);
        if (entry.episode) {
          const predecessor = entry.episode.previousEpisodeUuid;
          if (
            entry.episode.uuid !== sequence.episodeUuid ||
            entry.episode.name !== sequence.name ||
            entry.episode.batchNumber !== sequence.batchNumber ||
            predecessor !== sequence.sagaPreviousEpisodeUuid
          ) {
            throw new Error(
              `durable FIFO identity diverged from sequence state for ${agentId}/${sessionKey}; refusing remote mutation`,
            );
          }
        } else {
          entry.episode = {
            uuid: sequence.episodeUuid,
            name: sequence.name,
            batchNumber: sequence.batchNumber,
            ...(sequence.sagaPreviousEpisodeUuid
              ? { previousEpisodeUuid: sequence.sagaPreviousEpisodeUuid }
              : {}),
            submittedAt: Date.now(),
          };
          // This is the crucial write-ahead boundary. A remote call is forbidden
          // unless the exact UUID/body/predecessor identity is already on disk.
          if (!engine.checkpoint()) {
            throw new Error(
              `could not durably checkpoint episode identity ${sequence.name}; remote delivery not started`,
            );
          }
        }

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
        const committedUuid = acceptedEpisodeUuid(result);
        if (committedUuid !== sequence.episodeUuid) {
          throw new Error(
            `Graphiti committed unexpected UUID: expected ${sequence.episodeUuid}, got ${committedUuid}`,
          );
        }
        sequences.accept(agentId, sessionKey, sequence.batchNumber, committedUuid);

        logger.info("capture_committed", {
          agentId,
          group_id: agentId,
          saga: sessionKey,
          name: sequence.name,
          batchNumber: sequence.batchNumber,
          uuid: committedUuid,
          previousEpisodeUuid: sequence.sagaPreviousEpisodeUuid,
          messages: entry.buffer.messages.length,
          reason,
          durationMs: Date.now() - started,
        });
      };

      engine = new BufferEngine(
        cfg.agents,
        cfg.bufferLimit,
        cfg.bufferTimeout,
        sink,
        {
          initialState: restoredCaptureState,
          onStateChange: captureSpool
            ? (snapshot) =>
                captureSpool.save({
                  version: 4,
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
              action: "durable_head_retained",
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
              action: "remote_delivery_stopped",
              durableReplayRequired: true,
            });
            for (const [agentId, sessionKey] of lastSessionByAgent) {
              publishCaptureError(agentId, sessionKey, "durability", error);
            }
          },
          notifyPersistRecovered: () => {
            logger.info("capture_spool_write_recovered", { path: captureSpool?.path });
            for (const [agentId, sessionKey] of lastSessionByAgent) {
              clearCaptureError(agentId, sessionKey);
            }
          },
        },
      );

      const pollBackendQueueStatus = async (): Promise<void> => {
        const agentIds = new Set([...Object.keys(cfg.agents), ...lastSessionByAgent.keys()]);
        for (const agentId of agentIds) {
          try {
            const status = await client.getQueueStatus(agentId);
            lastQueueStatusByAgent.set(agentId, status);
            if (status.groupId !== agentId) {
              throw new Error(
                `Graphiti get_queue_status identity mismatch: requested ${agentId}, got ${status.groupId}`,
              );
            }

            const degraded =
              status.attempts > 0 ||
              Boolean(status.lastError) ||
              (status.pending > 0 && status.workerRunning === false);
            if (degraded) {
              const sessionKey = status.saga ?? lastSessionByAgent.get(agentId);
              const fingerprint = `retry:${status.episodeUuid ?? ""}:${status.attempts}:${status.pending}:${status.workerRunning}:${status.lastError ?? ""}`;
              const previousSession = backendReportedSessionByAgent.get(agentId);
              if (previousSession && sessionKey && previousSession !== sessionKey) {
                clearBackendError(agentId, previousSession);
              }
              if (sessionKey && backendFingerprintByAgent.get(agentId) !== fingerprint) {
                const stranded = status.pending > 0 && status.workerRunning === false;
                publishBackendError(agentId, sessionKey, {
                  status: "error",
                  source: "backend_queue",
                  message: stranded
                    ? "Graphiti backend has queued work but no worker; self-healing/retry is required"
                    : `Graphiti backend is retrying the current FIFO head after ${status.attempts} failure(s)`,
                  error: status.lastError ?? (stranded ? "queue worker not running" : "backend retry in progress"),
                  attempts: status.attempts,
                  pending: status.pending,
                  episodeUuid: status.episodeUuid ?? "",
                  episodeName: status.episodeName ?? "",
                  occurredAt: new Date().toISOString(),
                });
                backendReportedSessionByAgent.set(agentId, sessionKey);
                backendFingerprintByAgent.set(agentId, fingerprint);
                logger.warn("capture_backend_retrying", {
                  agentId,
                  group_id: agentId,
                  saga: sessionKey,
                  uuid: status.episodeUuid,
                  name: status.episodeName,
                  attempts: status.attempts,
                  pending: status.pending,
                  workerRunning: status.workerRunning,
                  error: status.lastError,
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
            const sessionKey = lastSessionByAgent.get(agentId);
            const fingerprint = `health:${errorText(error)}`;
            if (sessionKey && backendFingerprintByAgent.get(agentId) !== fingerprint) {
              publishBackendError(agentId, sessionKey, {
                status: "error",
                source: "backend_health",
                message: "Graphiti backend health check failed; durable head remains local",
                error: errorText(error),
                occurredAt: new Date().toISOString(),
              });
              backendReportedSessionByAgent.set(agentId, sessionKey);
              backendFingerprintByAgent.set(agentId, fingerprint);
              logger.warn("capture_backend_healthcheck_failed", {
                agentId,
                group_id: agentId,
                saga: sessionKey,
                error: errorText(error),
              });
            }
          }
        }
      };

      if (cfg.autoCapture) {
        engine.resumeRestored();
        queueHealthTimer = setInterval(() => {
          void pollBackendQueueStatus();
        }, CHECK_INTERVAL_SEC * 1000);
        queueHealthTimer.unref?.();
      }

      return {
        client,
        transcriptDeltas,
        captureSpool,
        captureLease,
        engine,
        statusHost,
        queueHealthTimer,
        restoredCaptureState,
        lastSessionByAgent,
        unconfiguredAgentsReported,
        lastQueueStatusByAgent,
      };
    } catch (error) {
      client.close();
      if (captureLease?.isHeld()) {
        try {
          captureLease.release();
        } catch (releaseError) {
          logger.error("capture_spool_lease_release_failed", {
            path: captureLease.path,
            error: errorText(releaseError),
          });
        }
      }
      throw error;
    }
  };

  const { runtime: pipeline, outcome } = acquireCaptureRuntime<CapturePipeline>({
    fingerprint: JSON.stringify({ cfg, spool: resolveCaptureSpoolPath() }),
    isStopped: (candidate) => candidate.engine.isStopped(),
    create: buildPipeline,
  });
  pipeline.statusHost.patchSessionEntry = api.runtime?.agent?.session?.patchSessionEntry;
  if (outcome !== "reused") logger.info("capture_pipeline", { outcome });

  const {
    client,
    transcriptDeltas,
    captureSpool,
    captureLease,
    engine,
    restoredCaptureState,
    lastSessionByAgent,
    unconfiguredAgentsReported,
    lastQueueStatusByAgent,
  } = pipeline;
  const queueHealthTimer = pipeline.queueHealthTimer;

  if (cfg.autoCapture) {
    api.on(
      "gateway_stop",
      async () => {
        if (queueHealthTimer) clearInterval(queueHealthTimer);
        // Abort long provider/backend polling before waiting for BufferEngine. The
        // durable head stays on disk and the next process reconciles it.
        client.close();
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
        if (captureLease?.isHeld()) {
          try {
            captureLease.release();
            logger.info("capture_spool_lease_released", { path: captureLease.path });
          } catch (error) {
            logger.error("capture_spool_lease_release_failed", {
              path: captureLease.path,
              error: errorText(error),
            });
          }
        }
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
      captureNote: (agentId, sessionKey, note) => {
        engine.addMessages(agentId, sessionKey, [{ role: "assistant", text: note }]);
        if (!engine.checkpoint()) {
          throw new Error("note was not durably checkpointed; it was not reported as remembered");
        }
      },
      localCaptureState: (agentId) => {
        const agent = engine.snapshot().agents.find((entry) => entry.agentId === agentId);
        const buffers = agent?.activeBuffers ?? [];
        const queue = agent?.queue ?? [];
        const assigned = queue.filter((entry) => entry.episode !== undefined);
        const oldestAwaiting = assigned.length > 0
          ? Math.min(...assigned.map((entry) => entry.episode?.submittedAt ?? entry.enqueuedAt))
          : undefined;
        const backend = lastQueueStatusByAgent.get(agentId);
        return {
          awaitingConfirmation: assigned.length,
          awaitingBytes: assigned.reduce(
            (sum, entry) => sum + JSON.stringify(entry.buffer).length,
            0,
          ),
          ...(oldestAwaiting !== undefined
            ? { oldestAwaitingMs: Date.now() - oldestAwaiting }
            : {}),
          notLanding:
            backend && backend.attempts > 0 && backend.episodeName
              ? [{ name: backend.episodeName, attempts: backend.attempts, ageMs: 0 }]
              : [],
          droppedForSpace: 0,
          bufferedMessages: buffers.reduce((sum, buffer) => sum + buffer.messages.length, 0),
          queuedBatches: queue.length,
          ...(buffers.length > 0
            ? {
                oldestBufferAgeMs:
                  Date.now() - Math.min(...buffers.map((buffer) => buffer.lastActivityAt)),
              }
            : {}),
          ...(captureSpool ? { spoolPath: captureSpool.path } : {}),
        };
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

      if (!cfg.agents[agentId] && !unconfiguredAgentsReported.has(agentId)) {
        unconfiguredAgentsReported.add(agentId);
        logger.warn("capture_agent_unconfigured", {
          agentId,
          group_id: agentId,
          configuredAgents: Object.keys(cfg.agents),
          participants: DEFAULT_ACTORS,
          backendQueueMonitoring: true,
        });
      }

      const snapshot = extractConversationMessages(Array.isArray(event.messages) ? event.messages : []);
      let delta;
      try {
        delta = transcriptDeltas.take(agentId, sessionKey, snapshot);
      } catch (error) {
        if (error instanceof TranscriptCursorError) {
          logger.error("capture_cursor_ambiguous", {
            agentId,
            group_id: agentId,
            saga: sessionKey,
            snapshotMessages: snapshot.length,
            error: errorText(error),
            action: "capture_stopped_without_advancing_cursor",
          });
          publishCaptureError(agentId, sessionKey, "cursor", error);
          return;
        }
        throw error;
      }

      if (delta.length === 0) {
        transcriptDeltas.commit(agentId, sessionKey);
        if (!engine.checkpoint()) {
          publishCaptureError(
            agentId,
            sessionKey,
            "durability",
            new Error("failed to checkpoint transcript cursor"),
          );
        } else {
          clearCaptureError(agentId, sessionKey);
        }
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

      transcriptDeltas.commit(agentId, sessionKey);
      if (!engine.checkpoint()) {
        publishCaptureError(
          agentId,
          sessionKey,
          "durability",
          new Error("messages and transcript cursor remain only in memory until spool recovers"),
        );
      } else {
        clearCaptureError(agentId, sessionKey);
      }
    });
  }

  logger.info("plugin_loaded", {
    autoCapture: cfg.autoCapture,
    autoRecall: cfg.autoRecall,
    captureMode: "durable_fifo_v4",
    bufferLimit: cfg.bufferLimit,
    bufferTimeout: cfg.bufferTimeout,
    captureDurableSpool: Boolean(captureSpool),
    captureSpoolPath: captureSpool?.path,
    captureLeasePath: captureLease?.path,
    excludeSessionPatterns: cfg.excludeSessionPatterns,
    agentTools: cfg.agentTools && Boolean(api.registerTool),
    restoredCaptureMessages: captureSnapshotStats(restoredCaptureState).messages,
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
