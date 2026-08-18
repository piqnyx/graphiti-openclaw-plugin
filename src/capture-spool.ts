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
import type { SessionWatermark } from "./transcript-delta.js";

/**
 * One authoritative local state: transcript cursors plus the per-agent durable
 * FIFO. A batch stays in that FIFO until Graphiti proves the complete Saga commit.
 * There is intentionally no second "accepted but unconfirmed" ledger anymore.
 */
export type CaptureSpoolState = {
  version: 4;
  agents: PersistedAgentCaptureState[];
  sessions: SessionWatermark[];
};

const SPOOL_VERSION = 4 as const;
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
    !value.tailHashes.every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/i.test(hash))
  ) {
    throw new Error("capture spool session watermark has invalid tailHashes");
  }
  if (!Number.isInteger(value.observedMessages) || (value.observedMessages as number) < 0) {
    throw new Error("capture spool session watermark has an invalid observedMessages");
  }
  if (typeof value.prefixDigest !== "string" || !/^[0-9a-f]{64}$/i.test(value.prefixDigest)) {
    throw new Error("capture spool session watermark has an invalid prefixDigest");
  }
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) {
    throw new Error("capture spool session watermark has an invalid updatedAt");
  }
  return {
    agentId: value.agentId,
    sessionKey: value.sessionKey,
    tailHashes: value.tailHashes as string[],
    observedMessages: value.observedMessages as number,
    prefixDigest: value.prefixDigest,
    updatedAt: value.updatedAt,
  };
}

type LegacyPending = {
  agentId: string;
  sessionKey: string;
  uuid: string;
  name: string;
  batchNumber: number;
  episodeBody: string;
  previousEpisodeUuids: string[];
  referenceTime: string;
  sagaPreviousEpisodeUuid?: string;
  submittedAt: number;
};

function parseLegacyPending(value: unknown): LegacyPending | undefined {
  if (!isObject(value)) return undefined;
  if (
    typeof value.agentId !== "string" ||
    typeof value.sessionKey !== "string" ||
    typeof value.uuid !== "string" ||
    typeof value.name !== "string" ||
    !Number.isInteger(value.batchNumber) ||
    typeof value.episodeBody !== "string" ||
    typeof value.referenceTime !== "string" ||
    typeof value.submittedAt !== "number" ||
    !Number.isFinite(value.submittedAt)
  ) {
    return undefined;
  }
  const previousEpisodeUuids = Array.isArray(value.previousEpisodeUuids)
    ? value.previousEpisodeUuids.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  return {
    agentId: value.agentId,
    sessionKey: value.sessionKey,
    uuid: value.uuid,
    name: value.name,
    batchNumber: value.batchNumber as number,
    episodeBody: value.episodeBody,
    previousEpisodeUuids,
    referenceTime: value.referenceTime,
    ...(typeof value.sagaPreviousEpisodeUuid === "string" && value.sagaPreviousEpisodeUuid
      ? { sagaPreviousEpisodeUuid: value.sagaPreviousEpisodeUuid }
      : {}),
    submittedAt: value.submittedAt,
  };
}

function legacyPendingQueueEntry(batch: LegacyPending): PersistedQueueEntry {
  let episode: unknown;
  try {
    episode = JSON.parse(batch.episodeBody) as unknown;
  } catch {
    throw new Error(`legacy pending batch ${batch.uuid} has invalid episodeBody JSON`);
  }
  if (!isObject(episode) || !isObject(episode.participants) || !Array.isArray(episode.messages)) {
    throw new Error(`legacy pending batch ${batch.uuid} has invalid conversation shape`);
  }
  const participants = episode.participants;
  if (typeof participants.user !== "string" || typeof participants.assistant !== "string") {
    throw new Error(`legacy pending batch ${batch.uuid} has invalid participants`);
  }
  if (!episode.messages.every(validMessage)) {
    throw new Error(`legacy pending batch ${batch.uuid} has invalid messages`);
  }
  const at = Number.isFinite(Date.parse(batch.referenceTime))
    ? Date.parse(batch.referenceTime)
    : batch.submittedAt;
  const previousEpisodeUuid =
    batch.sagaPreviousEpisodeUuid ?? batch.previousEpisodeUuids.at(-1);
  return {
    buffer: {
      sessionKey: batch.sessionKey,
      participants: { user: participants.user, assistant: participants.assistant },
      messages: episode.messages.map((message) => ({
        role: (message as { role: "user" | "assistant" }).role,
        text: (message as { text: string }).text,
      })),
      createdAt: at,
      lastActivityAt: at,
    },
    enqueuedAt: at,
    reason: "timeout",
    episode: {
      uuid: batch.uuid,
      name: batch.name,
      batchNumber: batch.batchNumber,
      ...(previousEpisodeUuid ? { previousEpisodeUuid } : {}),
      submittedAt: batch.submittedAt,
    },
  };
}

/**
 * Version 3 had two authoritative queues. Migrate every pending confirmation back
 * in front of the ordinary FIFO, preserving submission order, then throw the old
 * cursor hashes away because v4 uses cryptographic prefix identity. No batch is
 * discarded merely because the old architecture called it "accepted".
 */
function migrateV3(value: Record<string, unknown>): CaptureSpoolState {
  const agents = Array.isArray(value.agents) ? value.agents.map(parseAgentState) : [];
  const byAgent = new Map(agents.map((agent) => [agent.agentId, agent] as const));
  const pending = Array.isArray(value.pending)
    ? value.pending.map(parseLegacyPending).filter((batch): batch is LegacyPending => batch !== undefined)
    : [];
  pending.sort((a, b) => a.submittedAt - b.submittedAt || a.batchNumber - b.batchNumber);

  for (const batch of pending) {
    let agent = byAgent.get(batch.agentId);
    if (!agent) {
      agent = { agentId: batch.agentId, activeBuffers: [], queue: [] };
      agents.push(agent);
      byAgent.set(batch.agentId, agent);
    }
    if (agent.queue.some((entry) => entry.episode?.uuid === batch.uuid)) continue;
    agent.queue.unshift(legacyPendingQueueEntry(batch));
  }

  // unshift reverses within an agent; restore chronological order by the identity
  // submission timestamp before any unassigned later queue entries.
  for (const agent of agents) {
    const assigned = agent.queue.filter((entry) => entry.episode).sort(
      (a, b) => (a.episode?.submittedAt ?? 0) - (b.episode?.submittedAt ?? 0),
    );
    const unassigned = agent.queue.filter((entry) => !entry.episode);
    agent.queue = [...assigned, ...unassigned];
  }

  return { version: SPOOL_VERSION, agents, sessions: [] };
}

function parseState(value: unknown): CaptureSpoolState {
  if (!isObject(value) || !Array.isArray(value.agents)) {
    throw new Error(`capture spool must use schema version ${SPOOL_VERSION}`);
  }
  if (value.version === 4) {
    return {
      version: SPOOL_VERSION,
      agents: value.agents.map(parseAgentState),
      sessions: Array.isArray(value.sessions) ? value.sessions.map(parseSessionWatermark) : [],
    };
  }
  if (value.version === 3) return migrateV3(value);
  if (value.version === 2 || value.version === 1) {
    // These formats contain no reliable exact transcript cursor. Their local
    // unaccepted queue is still valuable and is preserved byte-for-structure.
    return {
      version: SPOOL_VERSION,
      agents: value.agents.map(parseAgentState),
      sessions: [],
    };
  }
  throw new Error(`capture spool must use schema version ${SPOOL_VERSION}`);
}

function hasData(state: CaptureSpoolState): boolean {
  if (state.sessions.length > 0) return true;
  return state.agents.some(
    (agent) => agent.activeBuffers.some((buffer) => buffer.messages.length > 0) || agent.queue.length > 0,
  );
}

/** Atomic replace + fsync for the single authoritative local checkpoint. */
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
        // The previous authoritative spool is untouched; temp cleanup is best effort.
      }
      throw error;
    }
  }
}
