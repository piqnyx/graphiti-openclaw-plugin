import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CHECK_INTERVAL_SEC,
  type EpisodeIdentity,
  type EpisodeJson,
} from "./buffer.js";
import { CaptureLease } from "./capture-lease.js";
import { resolveCaptureSpoolPath, resolveOpenClawStateDir } from "./capture-spool.js";
import { DEFAULT_ACTORS, type GraphitiPluginConfig } from "./config.js";
import {
  DurableBufferEngine,
  type DurableAgentSink,
} from "./durable-buffer-engine.js";
import { deriveEpisodeUuid, episodeNamePrefix, EpisodeSequenceTracker } from "./episode-sequence.js";
import { requireAgentId } from "./identity.js";
import type { GraphitiLogger } from "./logging.js";
import {
  GraphitiMcpClient,
  OPENCLAW_SOURCE_DESCRIPTION,
  type QueueStatus,
  type SagaState,
} from "./mcp-client.js";
import { matchSessionExclusion } from "./session-filter.js";
import { extractConversationMessages } from "./text.js";
import type { LocalCaptureState } from "./tools.js";
import { TranscriptCursorError } from "./transcript-delta.js";
import type {
  AgentEndEvent,
  HookContext,
  OpenClawPluginApi,
  PluginJsonValue,
} from "./types.js";

const CAPTURE_STATUS_NAMESPACE = "capture-status";
const CAPTURE_STATUS_DESCRIPTOR_ID = "capture-error";
const BACKEND_STATUS_NAMESPACE = "backend-queue-status";
const BACKEND_STATUS_DESCRIPTOR_ID = "backend-queue-error";
const CAPTURE_SHUTDOWN_GRACE_MS = 4_000;
const DURABLE_CAPTURE_DIR = "durable-capture-v1";

type CaptureFailureReason = "limit" | "timeout" | "cursor" | "durability";

export function resolveDurableCaptureRoot(): string {
  return join(resolveOpenClawStateDir(), "graphiti-openclaw-plugin", DURABLE_CAPTURE_DIR);
}

export type CaptureStatusHost = {
  patchSessionEntry?: NonNullable<
    NonNullable<NonNullable<OpenClawPluginApi["runtime"]>["agent"]>["session"]
  >["patchSessionEntry"];
};

export type CapturePipeline = {
  client: GraphitiMcpClient;
  engine: DurableBufferEngine;
  durableRoot: string;
  captureLease: CaptureLease;
  statusHost: CaptureStatusHost;
  handleAgentEnd: (rawEvent: unknown, ctx?: HookContext) => void;
  shutdown: () => Promise<void>;
  captureNote: (agentId: string, sessionKey: string, note: string) => void;
  localCaptureState: (agentId: string) => LocalCaptureState;
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

function expectedEpisodeName(sessionKey: string, batchNumber: number): string {
  return `${episodeNamePrefix(sessionKey)}-${batchNumber}`;
}

function captureSessionKey(agentId: string, sessionKey: string): string {
  return JSON.stringify([agentId, sessionKey]);
}

export function createCapturePipeline(params: {
  api: OpenClawPluginApi;
  cfg: GraphitiPluginConfig;
  logger: GraphitiLogger;
  excludedSessionPatterns: readonly RegExp[];
}): CapturePipeline {
  const { api, cfg, logger, excludedSessionPatterns } = params;
  const client = new GraphitiMcpClient(cfg.baseUrl, cfg.requestTimeoutMs, (kind, body) => {
    logger.debugContent(
      kind === "request" ? "mcp_raw_request" : "mcp_raw_response",
      { baseUrl: cfg.baseUrl },
      { raw: body },
    );
  });
  const sequences = new EpisodeSequenceTracker();
  const lastSessionByAgent = new Map<string, string>();
  const unconfiguredAgentsReported = new Set<string>();
  const backendReportedSessionByAgent = new Map<string, string>();
  const backendFingerprintByAgent = new Map<string, string>();
  const lastQueueStatusByAgent = new Map<string, QueueStatus>();
  const cursorErrorSessions = new Set<string>();
  const statusHost: CaptureStatusHost = {};
  const durableRoot = resolveDurableCaptureRoot();
  const legacySpoolPath = resolveCaptureSpoolPath();
  const captureLease = new CaptureLease(join(durableRoot, "owner"));
  let engine!: DurableBufferEngine;
  let queueHealthTimer: ReturnType<typeof setInterval> | undefined;
  let shutdownPromise: Promise<void> | undefined;

  try {
    // Never silently start a second persistence architecture beside an old spool.
    // The live deployment is intentionally upgraded only after the operator has
    // either migrated or explicitly reset the old queue together with the graph.
    if (existsSync(legacySpoolPath)) {
      throw new Error(
        `legacy Graphiti capture spool still exists at ${legacySpoolPath}; refusing to ignore queued data while starting ${durableRoot}`,
      );
    }

    captureLease.acquire();
    logger.info("capture_durable_lease_acquired", {
      root: durableRoot,
      path: captureLease.path,
      pid: process.pid,
    });

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
          const pluginState = { ...(pluginExtensions["graphiti-openclaw-plugin"] ?? {}) };
          if (value === undefined) delete pluginState[namespace];
          else pluginState[namespace] = value;
          if (Object.keys(pluginState).length > 0) {
            pluginExtensions["graphiti-openclaw-plugin"] = pluginState;
          } else {
            delete pluginExtensions["graphiti-openclaw-plugin"];
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
      reason: CaptureFailureReason,
      error: Error,
    ): void => {
      if (reason === "cursor") cursorErrorSessions.add(captureSessionKey(agentId, sessionKey));
      const value: PluginJsonValue = {
        status: "error",
        message:
          reason === "cursor"
            ? "Graphiti capture stopped for this session because transcript position is ambiguous"
            : reason === "durability"
              ? "Graphiti capture could not make a durable local transaction; transcript cursor was not advanced"
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
      sequences.hydrate(agentId, sessionKey, saga?.episodeCount ?? 0, saga?.lastEpisodeUuid);
      logger.debug("capture_sequence_hydrated", {
        agentId,
        group_id: agentId,
        saga: sessionKey,
        episodeCount: saga?.episodeCount ?? 0,
        lastEpisodeUuid: saga?.lastEpisodeUuid,
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
          `restored capture identity/body mismatch for ${agentId}/${sessionKey} batch ${identity.batchNumber}; refusing chronology guess`,
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

    const sink: DurableAgentSink = async (agentId, entry, reason, controls) => {
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
        if (
          entry.episode.uuid !== sequence.episodeUuid ||
          entry.episode.name !== sequence.name ||
          entry.episode.batchNumber !== sequence.batchNumber ||
          entry.episode.previousEpisodeUuid !== sequence.sagaPreviousEpisodeUuid
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
        // The deterministic Graphiti identity must exist on disk before the first
        // local MCP side effect. A crash can then only replay the exact same UUID.
        controls.checkpoint();
      }

      const referenceTime = new Date(entry.enqueuedAt).toISOString();
      logger.debug("capture_flush_start", {
        agentId,
        group_id: agentId,
        saga: sessionKey,
        queueSequence: controls.sequence,
        captureId: controls.captureId,
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
          queueSequence: controls.sequence,
          captureId: controls.captureId,
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
        queueSequence: controls.sequence,
        captureId: controls.captureId,
        name: sequence.name,
        batchNumber: sequence.batchNumber,
        uuid: committedUuid,
        previousEpisodeUuid: sequence.sagaPreviousEpisodeUuid,
        messages: entry.buffer.messages.length,
        reason,
        durationMs: Date.now() - started,
      });
    };

    engine = new DurableBufferEngine(
      durableRoot,
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
            action: "durable_head_retained",
            automaticRetry: true,
            retryIntervalSeconds: CHECK_INTERVAL_SEC,
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
          logger.error("capture_durable_write_failed", {
            root: durableRoot,
            error: errorText(error),
            action: "transcript_cursor_not_advanced",
            durableReplayRequired: true,
          });
          for (const [agentId, sessionKey] of lastSessionByAgent) {
            publishCaptureError(agentId, sessionKey, "durability", error);
          }
        },
        notifyPersistRecovered: () => {
          logger.info("capture_durable_write_recovered", { root: durableRoot });
          for (const [agentId, sessionKey] of lastSessionByAgent) {
            clearCaptureError(agentId, sessionKey);
          }
        },
      },
    );

    const pollBackendQueueStatus = async (): Promise<void> => {
      const agentIds = new Set([
        ...Object.keys(cfg.agents),
        ...engine.journal.queue.listAgents(),
        ...lastSessionByAgent.keys(),
      ]);
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
                error:
                  status.lastError ??
                  (stranded ? "queue worker not running" : "backend retry in progress"),
                attempts: status.attempts,
                pending: status.pending,
                episodeUuid: status.episodeUuid ?? "",
                episodeName: status.episodeName ?? "",
                occurredAt: new Date().toISOString(),
              });
              backendReportedSessionByAgent.set(agentId, sessionKey);
              backendFingerprintByAgent.set(agentId, fingerprint);
            }
            continue;
          }
          const previousSession = backendReportedSessionByAgent.get(agentId);
          if (previousSession) clearBackendError(agentId, previousSession);
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
          }
        }
      }
    };

    queueHealthTimer = setInterval(() => {
      void pollBackendQueueStatus();
    }, CHECK_INTERVAL_SEC * 1000);
    queueHealthTimer.unref?.();

    const handleAgentEnd = (rawEvent: unknown, ctx?: HookContext): void => {
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

      const snapshot = extractConversationMessages(
        Array.isArray(event.messages) ? event.messages : [],
      );
      let delta;
      try {
        delta = engine.ingestTranscript(agentId, sessionKey, snapshot);
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
        logger.error("capture_durable_transaction_failed", {
          agentId,
          group_id: agentId,
          saga: sessionKey,
          snapshotMessages: snapshot.length,
          error: errorText(error),
          action: "transcript_cursor_rolled_back",
        });
        publishCaptureError(
          agentId,
          sessionKey,
          "durability",
          error instanceof Error ? error : new Error(String(error)),
        );
        return;
      }

      if (delta.length > 0) {
        logger.debugContent(
          "capture_messages",
          {
            agentId,
            group_id: agentId,
            sessionKey,
            messages: delta.length,
            userMessages: delta.filter((message) => message.role === "user").length,
            assistantMessages: delta.filter((message) => message.role === "assistant").length,
            eventSuccess: event.success,
            durationMs: event.durationMs,
            durableQueueDepth: engine.queueDepth(agentId),
          },
          { messages: delta },
        );
      }
      const cursorKey = captureSessionKey(agentId, sessionKey);
      if (cursorErrorSessions.delete(cursorKey)) clearCaptureError(agentId, sessionKey);
    };

    const shutdown = (): Promise<void> => {
      shutdownPromise ??= (async () => {
        if (queueHealthTimer) clearInterval(queueHealthTimer);
        client.close();
        logger.info("capture_shutdown_checkpoint", {
          root: durableRoot,
          queuedBatches: engine.journal.queue
            .listAgents()
            .reduce((sum, agentId) => sum + engine.queueDepth(agentId), 0),
          graceMs: CAPTURE_SHUTDOWN_GRACE_MS,
        });
        await engine.shutdown(CAPTURE_SHUTDOWN_GRACE_MS);
        logger.info("capture_shutdown_complete", {
          root: durableRoot,
          durableReplayRequired: engine.journal.queue
            .listAgents()
            .some((agentId) => engine.queueDepth(agentId) > 0),
        });
        if (captureLease.isHeld()) {
          captureLease.release();
          logger.info("capture_durable_lease_released", { path: captureLease.path });
        }
      })();
      return shutdownPromise;
    };

    const captureNote = (agentId: string, sessionKey: string, note: string): void => {
      engine.appendSynthetic(agentId, sessionKey, { role: "assistant", text: note });
    };

    const localCaptureState = (agentId: string): LocalCaptureState => {
      const backend = lastQueueStatusByAgent.get(agentId);
      const queuedBatches = engine.queueDepth(agentId);
      return {
        awaitingConfirmation: queuedBatches,
        awaitingBytes: 0,
        notLanding:
          backend && backend.attempts > 0 && backend.episodeName
            ? [{ name: backend.episodeName, attempts: backend.attempts, ageMs: 0 }]
            : [],
        droppedForSpace: 0,
        bufferedMessages: engine.activeMessageCount(agentId),
        queuedBatches,
        spoolPath: durableRoot,
      };
    };

    return {
      client,
      engine,
      durableRoot,
      captureLease,
      statusHost,
      handleAgentEnd,
      shutdown,
      captureNote,
      localCaptureState,
    };
  } catch (error) {
    client.close();
    if (captureLease.isHeld()) {
      try {
        captureLease.release();
      } catch (releaseError) {
        logger.error("capture_durable_lease_release_failed", {
          path: captureLease.path,
          error: errorText(releaseError),
        });
      }
    }
    throw error;
  }
}

export { CAPTURE_SHUTDOWN_GRACE_MS };
