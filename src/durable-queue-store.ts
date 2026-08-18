import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const STORE_VERSION = 1 as const;
const SEGMENT_SIZE = 1_000;
const AGENTS_DIR = "agents";
const META_FILE = "meta.json";
const AGENT_FILE = "agent.json";
const QUEUE_DIR = "queue";

export type DurableQueueRecord<T = unknown> = {
  version: 1;
  sequence: number;
  agentId: string;
  captureId: string;
  enqueuedAt: number;
  payload: T;
};

type AgentMeta = {
  version: 1;
  agentId: string;
  nextSequence: number;
  headSequence: number;
};

type AgentManifest = {
  version: 1;
  agentId: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Atomic replace. Callers get the old file or the new file, never half JSON. */
function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
    chmodSync(path, 0o600);
    fsyncDirectory(dir);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The authoritative file was not replaced; leftover temp cleanup is best effort.
    }
    throw error;
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/**
 * A filesystem-safe, non-reversible directory key. Agent IDs never become paths.
 * The manifest inside the directory is still checked on every open, so a hash/path
 * mix-up cannot silently turn into cross-agent queue access.
 */
export function durableAgentKey(agentId: string): string {
  if (!agentId.trim()) throw new Error("agentId must be non-empty");
  return createHash("sha256").update(agentId, "utf8").digest("hex");
}

function parseMeta(value: unknown, expectedAgentId: string): AgentMeta {
  if (!isObject(value) || value.version !== STORE_VERSION || value.agentId !== expectedAgentId) {
    throw new Error(`durable queue metadata identity mismatch for agent ${expectedAgentId}`);
  }
  if (!positiveSafeInteger(value.nextSequence) || !positiveSafeInteger(value.headSequence)) {
    throw new Error(`durable queue metadata has invalid sequence counters for agent ${expectedAgentId}`);
  }
  if (value.headSequence > value.nextSequence) {
    throw new Error(`durable queue metadata head is past tail for agent ${expectedAgentId}`);
  }
  return {
    version: STORE_VERSION,
    agentId: expectedAgentId,
    nextSequence: value.nextSequence,
    headSequence: value.headSequence,
  };
}

function parseManifest(value: unknown, expectedAgentId: string): AgentManifest {
  if (!isObject(value) || value.version !== STORE_VERSION || value.agentId !== expectedAgentId) {
    throw new Error(`durable queue directory identity mismatch for agent ${expectedAgentId}`);
  }
  return { version: STORE_VERSION, agentId: expectedAgentId };
}

function parseRecord<T>(value: unknown, expectedAgentId: string, sequence: number): DurableQueueRecord<T> {
  if (!isObject(value) || value.version !== STORE_VERSION) {
    throw new Error(`durable queue entry ${sequence} has invalid schema`);
  }
  if (value.agentId !== expectedAgentId || value.sequence !== sequence) {
    throw new Error(`durable queue entry ${sequence} identity mismatch for agent ${expectedAgentId}`);
  }
  if (typeof value.captureId !== "string" || !/^[0-9a-f]{64}$/i.test(value.captureId)) {
    throw new Error(`durable queue entry ${sequence} has invalid captureId`);
  }
  if (typeof value.enqueuedAt !== "number" || !Number.isFinite(value.enqueuedAt)) {
    throw new Error(`durable queue entry ${sequence} has invalid enqueuedAt`);
  }
  return {
    version: STORE_VERSION,
    sequence,
    agentId: expectedAgentId,
    captureId: value.captureId,
    enqueuedAt: value.enqueuedAt,
    payload: value.payload as T,
  };
}

function sequenceName(sequence: number): string {
  return sequence.toString(10).padStart(20, "0");
}

function segmentName(sequence: number): string {
  return Math.floor((sequence - 1) / SEGMENT_SIZE).toString(10).padStart(12, "0");
}

/**
 * Segmented, disk-authoritative FIFO storage.
 *
 * This deliberately stores one immutable-sized batch per file instead of rewriting
 * one ever-growing JSON spool. A provider outage can therefore accumulate gigabytes
 * without making every new message rewrite, parse, or retain the whole backlog.
 * Only the current queue record is read into memory by `peekHead()`.
 *
 * `allocateSequence()` may leave gaps if the process dies before publishing the
 * corresponding record. Gaps are harmless and are skipped by the head reader. The
 * higher capture transaction must recover any persisted flush intent before starting
 * delivery after a restart; that is what distinguishes an abandoned allocation from
 * an enqueue that still needs materialising.
 */
export class DurableQueueStore {
  constructor(readonly root: string) {
    mkdirSync(join(root, AGENTS_DIR), { recursive: true, mode: 0o700 });
  }

  private agentDir(agentId: string): string {
    return join(this.root, AGENTS_DIR, durableAgentKey(agentId));
  }

  private metaPath(agentId: string): string {
    return join(this.agentDir(agentId), META_FILE);
  }

  private entryPath(agentId: string, sequence: number): string {
    return join(
      this.agentDir(agentId),
      QUEUE_DIR,
      segmentName(sequence),
      `${sequenceName(sequence)}.json`,
    );
  }

  private ensureAgent(agentId: string): AgentMeta {
    const dir = this.agentDir(agentId);
    const manifestPath = join(dir, AGENT_FILE);
    const metaPath = join(dir, META_FILE);
    if (!existsSync(dir)) {
      mkdirSync(join(dir, QUEUE_DIR), { recursive: true, mode: 0o700 });
      writeJsonAtomic(manifestPath, { version: STORE_VERSION, agentId } satisfies AgentManifest);
      const meta: AgentMeta = {
        version: STORE_VERSION,
        agentId,
        nextSequence: 1,
        headSequence: 1,
      };
      writeJsonAtomic(metaPath, meta);
      fsyncDirectory(dirname(dir));
      return meta;
    }

    if (!existsSync(manifestPath) || !existsSync(metaPath)) {
      throw new Error(`durable queue directory for agent ${agentId} is incomplete; refusing repair by guess`);
    }
    parseManifest(readJson(manifestPath), agentId);
    return parseMeta(readJson(metaPath), agentId);
  }

  /** Reserve a monotonically increasing per-agent queue sequence. Gaps are allowed. */
  allocateSequence(agentId: string): number {
    const meta = this.ensureAgent(agentId);
    const sequence = meta.nextSequence;
    if (sequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`durable queue sequence exhausted for agent ${agentId}`);
    }
    meta.nextSequence += 1;
    writeJsonAtomic(this.metaPath(agentId), meta);
    return sequence;
  }

  /** Publish an allocated sequence. Existing identical publication is idempotent. */
  publish<T>(record: DurableQueueRecord<T>): void {
    const meta = this.ensureAgent(record.agentId);
    if (!positiveSafeInteger(record.sequence) || record.sequence >= meta.nextSequence) {
      throw new Error(
        `durable queue sequence ${record.sequence} was not allocated for agent ${record.agentId}`,
      );
    }
    if (!/^[0-9a-f]{64}$/i.test(record.captureId)) {
      throw new Error("durable queue captureId must be a SHA-256 hex digest");
    }
    const path = this.entryPath(record.agentId, record.sequence);
    if (existsSync(path)) {
      const existing = parseRecord<T>(readJson(path), record.agentId, record.sequence);
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error(
          `durable queue sequence ${record.sequence} already contains different data; refusing overwrite`,
        );
      }
      return;
    }
    writeJsonAtomic(path, record);
  }

  /** Read one exact queue record without scanning or loading its neighbours. */
  read<T>(agentId: string, sequence: number): DurableQueueRecord<T> | undefined {
    this.ensureAgent(agentId);
    const path = this.entryPath(agentId, sequence);
    if (!existsSync(path)) return undefined;
    return parseRecord<T>(readJson(path), agentId, sequence);
  }

  /** Atomically rewrite one existing record, used when the head receives remote identity. */
  update<T>(
    agentId: string,
    sequence: number,
    update: (record: DurableQueueRecord<T>) => DurableQueueRecord<T>,
  ): DurableQueueRecord<T> {
    const current = this.read<T>(agentId, sequence);
    if (!current) throw new Error(`durable queue entry ${agentId}/${sequence} does not exist`);
    const next = update(current);
    if (
      next.version !== STORE_VERSION ||
      next.agentId !== current.agentId ||
      next.sequence !== current.sequence ||
      next.captureId !== current.captureId ||
      next.enqueuedAt !== current.enqueuedAt
    ) {
      throw new Error(`durable queue update attempted to change immutable identity ${agentId}/${sequence}`);
    }
    writeJsonAtomic(this.entryPath(agentId, sequence), next);
    return next;
  }

  /**
   * Return the first published record. Missing allocated sequence numbers are gaps,
   * not data, and are compacted out of the persisted head pointer.
   */
  peekHead<T>(agentId: string): DurableQueueRecord<T> | undefined {
    const meta = this.ensureAgent(agentId);
    let sequence = meta.headSequence;
    while (sequence < meta.nextSequence) {
      const record = this.read<T>(agentId, sequence);
      if (record) {
        if (sequence !== meta.headSequence) {
          meta.headSequence = sequence;
          writeJsonAtomic(this.metaPath(agentId), meta);
        }
        return record;
      }
      sequence += 1;
    }
    if (meta.headSequence !== meta.nextSequence) {
      meta.headSequence = meta.nextSequence;
      writeJsonAtomic(this.metaPath(agentId), meta);
    }
    return undefined;
  }

  /**
   * Remove only the current published head. File unlink is durable before advancing
   * metadata, so a crash can at worst leave a stale head pointer to an absent file;
   * restart skips that gap. The opposite ordering could lose an unprocessed record.
   */
  removeHead(agentId: string, sequence: number): void {
    const head = this.peekHead(agentId);
    if (!head || head.sequence !== sequence) {
      throw new Error(
        `refusing to remove non-head durable queue entry ${agentId}/${sequence}; current head is ${head?.sequence ?? "none"}`,
      );
    }
    const path = this.entryPath(agentId, sequence);
    unlinkSync(path);
    fsyncDirectory(dirname(path));

    const meta = this.ensureAgent(agentId);
    if (meta.headSequence <= sequence) {
      meta.headSequence = sequence + 1;
      writeJsonAtomic(this.metaPath(agentId), meta);
    }
  }

  /** Cheap upper bound; gaps may make this larger than the actual number of files. */
  approximateDepth(agentId: string): number {
    const meta = this.ensureAgent(agentId);
    return Math.max(0, meta.nextSequence - meta.headSequence);
  }

  /** Discover agent identities from manifests without trusting directory names. */
  listAgents(): string[] {
    const root = join(this.root, AGENTS_DIR);
    if (!existsSync(root)) return [];
    const result: string[] = [];
    for (const key of readdirSync(root)) {
      const manifestPath = join(root, key, AGENT_FILE);
      if (!existsSync(manifestPath)) continue;
      const value = readJson(manifestPath);
      if (!isObject(value) || value.version !== STORE_VERSION || typeof value.agentId !== "string") {
        throw new Error(`durable queue contains invalid agent manifest ${key}`);
      }
      if (durableAgentKey(value.agentId) !== key) {
        throw new Error(`durable queue manifest/path mismatch for ${value.agentId}`);
      }
      result.push(value.agentId);
    }
    return result.sort();
  }
}
