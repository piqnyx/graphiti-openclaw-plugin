import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  EpisodeIdentity,
  PersistedAgentCaptureState,
  PersistedBuffer,
  PersistedQueueEntry,
} from "./buffer.js";
import type { PendingBatch } from "./pending-confirmation.js";
import type { SessionWatermark } from "./transcript-delta.js";

/**
 * Durable capture state.
 *
 * Three things that must survive a restart together: batches not yet handed to
 * Graphiti, batches handed over but not yet seen in the graph, and how far each
 * session's transcript was already captured. Splitting them across files would
 * let a crash land between two writes and leave the set inconsistent.
 */
export type CaptureSpoolState = {
  version: 3;
  agents: PersistedAgentCaptureState[];
  sessions: SessionWatermark[];
  pending: PendingBatch[];
};

const SPOOL_VERSION = 3 as const;
const PREVIOUS_SPOOL_VERSION = 2 as const;
const LEGACY_SPOOL_VERSION = 1 as const;
const SPOOL_DIR_NAME = "graphiti-openclaw-plugin";
const SPOOL_FILE_NAME = "capture-spool.json";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveUserPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

/** Resolve OpenClaw's mutable state directory without importing OpenClaw internals. */
export function resolveOpenClawStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  return override ? resolveUserPath(override) : join(homedir(), ".openclaw");
}

export function resolveCaptureSpoolPath(): string {
  return join(resolveOpenClawStateDir(), SPOOL_DIR_NAME, SPOOL_FILE_NAME);
}

function validMessage(value: unknown): boolean {
  return (
    isObject(value) &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.text === "string"
  );
}

function parsePersistedBuffer(value: unknown): PersistedBuffer {
  if (!isObject(value)) throw new Error("capture spool contains an invalid buffer");
  if (typeof value.sessionKey !== "string" || value.sessionKey.trim() === "") {
    throw new Error("capture spool buffer has an invalid sessionKey");
  }
  if (!Array.isArray(value.messages) || !value.messages.every(validMessage)) {
    throw new Error("capture spool buffer has invalid messages");
  }
  if (!isObject(value.participants)) {
    throw new Error("capture spool buffer has invalid participants");
  }
  if (
    typeof value.participants.user !== "string" ||
    typeof value.participants.assistant !== "string"
  ) {
    throw new Error("capture spool buffer has invalid participant names");
  }
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
    throw new Error("capture spool buffer has invalid createdAt");
  }
  if (typeof value.lastActivityAt !== "number" || !Number.isFinite(value.lastActivityAt)) {
    throw new Error("capture spool buffer has invalid lastActivityAt");
  }

  return {
    sessionKey: value.sessionKey,
    participants: {
      user: value.participants.user,
      assistant: value.participants.assistant,
    },
    messages: value.messages.map((message) => ({
      role: (message as { role: "user" | "assistant" }).role,
      text: (message as { text: string }).text,
    })),
    createdAt: value.createdAt,
    lastActivityAt: value.lastActivityAt,
  };
}

function parseEpisodeIdentity(value: unknown): EpisodeIdentity {
  if (!isObject(value)) throw new Error("capture spool queue entry has an invalid episode identity");
  if (typeof value.uuid !== "string" || value.uuid.trim() === "") {
    throw new Error("capture spool episode identity has an invalid uuid");
  }
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw new Error("capture spool episode identity has an invalid name");
  }
  if (!Number.isInteger(value.batchNumber) || (value.batchNumber as number) < 1) {
    throw new Error("capture spool episode identity has an invalid batchNumber");
  }
  if (
    value.previousEpisodeUuid !== undefined &&
    (typeof value.previousEpisodeUuid !== "string" || value.previousEpisodeUuid.trim() === "")
  ) {
    throw new Error("capture spool episode identity has an invalid previousEpisodeUuid");
  }
  if (typeof value.submittedAt !== "number" || !Number.isFinite(value.submittedAt)) {
    throw new Error("capture spool episode identity has an invalid submittedAt");
  }
  return {
    uuid: value.uuid,
    name: value.name,
    batchNumber: value.batchNumber as number,
    ...(value.previousEpisodeUuid === undefined
      ? {}
      : { previousEpisodeUuid: value.previousEpisodeUuid as string }),
    submittedAt: value.submittedAt,
  };
}

function parseQueueEntry(value: unknown): PersistedQueueEntry {
  if (!isObject(value)) throw new Error("capture spool contains an invalid queue entry");
  if (value.reason !== "limit" && value.reason !== "timeout") {
    throw new Error("capture spool queue entry has an invalid reason");
  }
  if (typeof value.enqueuedAt !== "number" || !Number.isFinite(value.enqueuedAt)) {
    throw new Error("capture spool queue entry has an invalid enqueuedAt");
  }
  return {
    buffer: parsePersistedBuffer(value.buffer),
    enqueuedAt: value.enqueuedAt,
    reason: value.reason,
    ...(value.episode === undefined ? {} : { episode: parseEpisodeIdentity(value.episode) }),
  };
}

function parseAgentState(value: unknown): PersistedAgentCaptureState {
  if (!isObject(value)) throw new Error("capture spool contains an invalid agent state");
  if (typeof value.agentId !== "string" || value.agentId.trim() === "") {
    throw new Error("capture spool agent state has an invalid agentId");
  }
  if (!Array.isArray(value.activeBuffers) || !Array.isArray(value.queue)) {
    throw new Error("capture spool agent state has invalid buffers or queue");
  }
  return {
    agentId: value.agentId,
    activeBuffers: value.activeBuffers.map(parsePersistedBuffer),
    queue: value.queue.map(parseQueueEntry),
  };
}

function parseSessionWatermark(value: unknown): SessionWatermark {
  if (!isObject(value)) throw new Error("capture spool contains an invalid session watermark");
  if (typeof value.agentId !== "string" || value.agentId.trim() === "") {
    throw new Error("capture spool session watermark has an invalid agentId");
  }
  if (typeof value.sessionKey !== "string" || value.sessionKey.trim() === "") {
    throw new Error("capture spool session watermark has an invalid sessionKey");
  }
  if (
    !Array.isArray(value.tailHashes) ||
    !value.tailHashes.every((hash) => typeof hash === "string" && hash.trim() !== "")
  ) {
    throw new Error("capture spool session watermark has invalid tailHashes");
  }
  if (typeof value.observedMessages !== "number" || !Number.isFinite(value.observedMessages)) {
    throw new Error("capture spool session watermark has an invalid observedMessages");
  }
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) {
    throw new Error("capture spool session watermark has an invalid updatedAt");
  }
  return {
    agentId: value.agentId,
    sessionKey: value.sessionKey,
    tailHashes: value.tailHashes as string[],
    observedMessages: value.observedMessages,
    updatedAt: value.updatedAt,
  };
}

/**
 * Version 1 spools carry unaccepted batches but no session watermarks. They are
 * accepted as-is so a gateway upgrade never strands capture data behind a
 * schema check.
 */
function parseState(value: unknown): CaptureSpoolState {
  if (!isObject(value) || !Array.isArray(value.agents)) {
    throw new Error(`capture spool must use schema version ${SPOOL_VERSION}`);
  }
  if (value.version === PREVIOUS_SPOOL_VERSION) {
    // Version 2 knew nothing of confirmation. Its batches were dropped from the
    // spool the moment Graphiti accepted them, so there is nothing outstanding to
    // recover — an empty ledger is the truth, not a loss.
    return {
      version: SPOOL_VERSION,
      agents: Array.isArray(value.agents) ? value.agents.map(parseAgentState) : [],
      sessions: Array.isArray(value.sessions) ? value.sessions.map(parseSessionWatermark) : [],
      pending: [],
    };
  }
  if (value.version === LEGACY_SPOOL_VERSION) {
    return {
      version: SPOOL_VERSION,
      agents: value.agents.map(parseAgentState),
      sessions: [],
      pending: [],
    };
  }
  if (value.version !== SPOOL_VERSION) {
    throw new Error(`capture spool must use schema version ${SPOOL_VERSION}`);
  }
  return {
    version: SPOOL_VERSION,
    agents: value.agents.map(parseAgentState),
    sessions: Array.isArray(value.sessions) ? value.sessions.map(parseSessionWatermark) : [],
    pending: Array.isArray(value.pending) ? value.pending.filter(validPendingBatch) : [],
  };
}

/**
 * A pending batch is only worth restoring if it can still be resubmitted, which
 * takes its identity and its body. A malformed entry is dropped rather than
 * repaired: resubmitting a guess would write a wrong episode under a real uuid.
 */
function validPendingBatch(value: unknown): value is PendingBatch {
  return (
    isObject(value) &&
    typeof value.uuid === "string" &&
    value.uuid.trim() !== "" &&
    typeof value.agentId === "string" &&
    typeof value.sessionKey === "string" &&
    typeof value.name === "string" &&
    typeof value.episodeBody === "string" &&
    typeof value.batchNumber === "number" &&
    Number.isInteger(value.batchNumber) &&
    typeof value.submittedAt === "number" &&
    typeof value.attempts === "number"
  );
}

function hasData(state: CaptureSpoolState): boolean {
  if (state.sessions.length > 0 || state.pending.length > 0) return true;
  return state.agents.some(
    (agent) => agent.activeBuffers.some((buffer) => buffer.messages.length > 0) || agent.queue.length > 0,
  );
}

/**
 * Atomic local checkpoint for unaccepted capture data.
 *
 * A CaptureSpool instance may remove the shared file only after that same
 * instance has successfully loaded or written it. This prevents another empty
 * plugin runtime from deleting capture data that appeared after its own startup.
 */
export class CaptureSpool {
  readonly path: string;
  private ownsFile = false;

  constructor(path = resolveCaptureSpoolPath()) {
    this.path = path;
  }

  load(): CaptureSpoolState | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      const state = parseState(JSON.parse(readFileSync(this.path, "utf8")) as unknown);
      this.ownsFile = true;
      return state;
    } catch (error) {
      throw new Error(
        `failed to read durable Graphiti capture spool ${this.path}; refusing to overwrite it: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  save(snapshot: CaptureSpoolState): void {
    if (!hasData(snapshot)) {
      // register() may run in more than one OpenClaw runtime/process. An instance
      // that started with no spool and never wrote capture data must not unlink a
      // file created later by another live instance.
      if (!this.ownsFile) return;
      try {
        unlinkSync(this.path);
      } catch (error) {
        if (!isObject(error) || error.code !== "ENOENT") throw error;
      }
      this.ownsFile = false;
      return;
    }

    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const fd = openSync(tempPath, "w", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(snapshot)}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    try {
      renameSync(tempPath, this.path);
      chmodSync(this.path, 0o600);
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
      this.ownsFile = true;
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup; the authoritative previous spool was never replaced.
      }
      throw error;
    }
  }
}
