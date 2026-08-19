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
import { advanceCursor, emptyCursor, rebaseCursor } from "./capture-cursor.js";
import { defaultAgentDbPath, TranscriptStore, type TranscriptRow } from "./transcript-store.js";
import { extractConversationMessages, type ConversationMessage } from "./text.js";
import type { LocalCaptureState } from "./tools.js";
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

type CaptureFailureReason = "limit" | "timeout" | "durability";

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

/**
 * A message body rendered for the log, never for storage.
 *
 * An inbound photo arrives as a base64 block -- 224 KB of it, measured -- so the
 * raw content cannot be printed as-is without drowning the journal. Text is kept
 * because that is the point of the line; everything else is named and counted.
 */
function describeContent(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.slice(0, LOG_TEXT_CHARS);
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "?";
      const type = (block as { type?: unknown }).type;
      const text = (block as { text?: unknown }).text;
      if (type === "text" && typeof text === "string") return text;
      const data = (block as { data?: unknown }).data;
      const size = typeof data === "string" ? `(${Math.round(data.length / 1024)}KB)` : "";
      return `<${String(type)}${size}>`;
    })
    .join(" | ")
    .slice(0, LOG_TEXT_CHARS);
}

/** Enough of a message to recognise it in the log without flooding the journal. */
const LOG_TEXT_CHARS = 2000;
/** Per-turn ceiling on per-row logging; the remainder is counted, not printed. */
const MAX_LOGGED_ROWS = 50;

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
  /**
   * One open store per agent, verified before it is ever used.
   *
   * Verification happens here, at registration, so a schema that moved under us
   * stops the plugin loading instead of quietly capturing nothing. That is the
   * safe failure: the gateway keeps writing its transcript, and a repaired plugin
   * reads the backlog from its cursor. Guessing against a changed schema is the
   * only way to actually lose conversation.
   */
  const storesByAgent = new Map<string, TranscriptStore>();
  const missingStoresReported = new Set<string>();
  const agentDbPathFor = (agentId: string): string =>
    cfg.agentDbPath ? cfg.agentDbPath.replaceAll("{agentId}", agentId) : defaultAgentDbPath(agentId);

  /**
   * The store for an agent, or nothing when that agent has never spoken.
   *
   * Absence and disagreement are different failures and must not share an outcome.
   * A configured agent with no store yet is ordinary -- the gateway creates the
   * file on its first turn -- and refusing to load over it would take capture down
   * for every other agent too. A store that exists but no longer matches the shape
   * we read is the loud one, and it is left to throw.
   */
  const storeFor = (agentId: string): TranscriptStore | undefined => {
    const existing = storesByAgent.get(agentId);
    if (existing) return existing;
    const path = agentDbPathFor(agentId);
    if (!existsSync(path)) {
      if (!missingStoresReported.has(agentId)) {
        missingStoresReported.add(agentId);
        logger.info("capture_store_absent", {
          agentId,
          group_id: agentId,
          path,
          action: "waiting_for_first_turn",
        });
      }
      return undefined;
    }
    const store = new TranscriptStore(path);
    store.verify();
    missingStoresReported.delete(agentId);
    storesByAgent.set(agentId, store);
    logger.info("capture_store_opened", { agentId, group_id: agentId, path });
    return store;
  };
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

    // Only now, holding the lease. OpenClaw calls register() several times per
    // process, and a call that will be turned away as a second writer must not
    // have opened four databases on its way to being refused -- nothing closes
    // them afterwards, and the handles accumulate with every reload.
    for (const agentId of Object.keys(cfg.agents)) storeFor(agentId);

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
          reason: { enum: ["limit", "timeout", "durability"] },
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
      const value: PluginJsonValue = {
        status: "error",
        message:
          reason === "durability"
            ? "Graphiti capture could not read the transcript store or make a durable local transaction; the cursor was not advanced"
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
      if (!saga.integrityOk) {
        logger.warn("capture_saga_integrity_warning", {
          agentId,
          group_id: agentId,
          saga: sessionKey,
          integrityErrors: saga.integrityErrors,
        });
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

      // Read the gateway's own store rather than the hook payload. The hook is a
      // lossy view of it -- text rewritten, identity stripped, entries spliced in --
      // and anything it drops is gone for good. The store keeps every row under a
      // per-session seq with the id the gateway assigned it, so the same read is
      // safe to repeat after a crash or a week of downtime.
      let delta: ConversationMessage[] = [];
      let rowsRead = 0;
      try {
        const store = storeFor(agentId);
        if (!store) return;
        const sessionId = store.currentSessionId(sessionKey);
        if (!sessionId) {
          logger.debug("capture_skipped", {
            agentId,
            group_id: agentId,
            saga: sessionKey,
            reason: "session_not_in_store",
          });
          return;
        }

        const previous = engine.sessionCursor(agentId, sessionKey);
        if (!previous && cfg.adoptExistingHistoryOnFirstSight) {
          // Asked for explicitly: take note of what the session already holds and
          // start after it. Only correct when that history is already in memory
          // from before this cursor existed, which is why it is not the default --
          // a conversation that begins now is written and read in the same turn.
          // Sliced like any other read: adopting a long session must not pull its
          // every row, base64 photographs and all, into memory at once.
          let adopted = emptyCursor(sessionId);
          let seenRows = 0;
          for (;;) {
            const slice = store.readAfter(sessionId, adopted.lastSeq);
            if (slice.scannedThrough <= adopted.lastSeq) break;
            seenRows += slice.rows.length;
            adopted = advanceCursor(adopted, sessionId, slice.rows, slice.scannedThrough);
          }
          engine.checkpointCursor(agentId, sessionKey, adopted);
          logger.info("capture_session_adopted", {
            agentId,
            group_id: agentId,
            saga: sessionKey,
            existingRows: seenRows,
            fromSeq: adopted.lastSeq,
            action: "history_left_to_whatever_already_holds_it",
          });
          return;
        }
        // A rewind repoints the key at a new session whose opening rows are copies
        // of the old ones, so a changed id means read from the beginning and let
        // the captured-id set discard what has already been taken.
        // Follow a rewind without forgetting: the ids come along, the row count
        // restarts, and the copied prefix is recognised instead of captured again.
        const cursor = previous ? rebaseCursor(previous, sessionId) : emptyCursor(sessionId);
        const read = store.readAfter(sessionId, cursor.lastSeq);
        const rows = read.rows;
        rowsRead = rows.length;

        // Membership by set, not by scanning the list per row: a first read of a
        // long session compares every row against everything taken so far, and the
        // list is ten thousand ids deep.
        const taken = new Set(cursor.capturedEventIds);
        const fresh = rows.filter((row: TranscriptRow) => !taken.has(row.eventId));
        const observedSeq = read.scannedThrough;

        let logged = 0;
        for (const row of fresh) {
          const [message] = extractConversationMessages([row.message]);
          if (logged < MAX_LOGGED_ROWS) {
            logged += 1;
              logger.debugContent(
              "capture_row",
              { agentId, group_id: agentId, saga: sessionKey, seq: row.seq, eventId: row.eventId },
              {
                rawText: describeContent(row.message),
                sanitized: message?.text ?? "",
                verdict: message ? "captured" : "dropped_by_sanitisation",
              },
            );
          }
          if (message) delta.push(message);
        }
        if (fresh.length > MAX_LOGGED_ROWS) {
          logger.debug("capture_rows_not_logged", {
            agentId,
            group_id: agentId,
            saga: sessionKey,
            suppressed: fresh.length - MAX_LOGGED_ROWS,
          });
        }

        const advanced = advanceCursor(cursor, sessionId, rows, observedSeq);
        if (delta.length > 0) engine.ingest(agentId, sessionKey, delta, advanced);
        // A read that saw nothing new has nothing to make durable; writing the same
        // cursor again would cost an fsync on every idle turn of every session.
        else if (observedSeq > cursor.lastSeq) {
          engine.checkpointCursor(agentId, sessionKey, advanced);
        }
      } catch (error) {
        logger.error("capture_durable_transaction_failed", {
          agentId,
          group_id: agentId,
          saga: sessionKey,
          rowsRead,
          error: errorText(error),
          action: "cursor_not_advanced",
        });
        publishCaptureError(
          agentId,
          sessionKey,
          "durability",
          error instanceof Error ? error : new Error(String(error)),
        );
        return;
      }

      // A read that worked ends any error the session is still showing; without
      // this a single transient store failure leaves a permanent red flag.
      clearCaptureError(agentId, sessionKey);

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
            rowsRead,
            eventSuccess: event.success,
            durationMs: event.durationMs,
            durableQueueDepth: engine.queueDepth(agentId),
          },
          { messages: delta },
        );
      }
    };

    const shutdown = (): Promise<void> => {
      shutdownPromise ??= (async () => {
        if (queueHealthTimer) clearInterval(queueHealthTimer);
        client.close();
        for (const store of storesByAgent.values()) store.close();
        storesByAgent.clear();
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
      let storePath: string | undefined;
      let storeReadable = false;
      try {
        const store = storeFor(agentId);
        storePath = store?.path ?? agentDbPathFor(agentId);
        if (store) {
          store.verify();
          storeReadable = true;
        }
      } catch (error) {
        logger.warn("capture_store_unreadable", {
          agentId,
          group_id: agentId,
          error: errorText(error),
        });
      }
      return {
        ...(storePath ? { storePath } : {}),
        storeReadable,
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
    // Registration that does not complete leaves nothing open behind it.
    for (const store of storesByAgent.values()) store.close();
    storesByAgent.clear();
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
