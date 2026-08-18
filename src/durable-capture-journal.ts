import { createHash, randomUUID } from "node:crypto";
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
import {
  DurableQueueStore,
  durableAgentKey,
  type DurableQueueRecord,
} from "./durable-queue-store.js";

const JOURNAL_VERSION = 1 as const;
const SESSIONS_DIR = "sessions";

export type JournalBatch<TBatch> = {
  captureId: string;
  enqueuedAt: number;
  payload: TBatch;
};

export type JournalSession<TState, TBatch> = {
  version: 1;
  agentId: string;
  sessionKey: string;
  committed: TState;
  pending?: {
    transactionId: string;
    finalState: TState;
    records: DurableQueueRecord<TBatch>[];
  };
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
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
      // The old journal file remains authoritative.
    }
    throw error;
  }
}

function sessionKeyHash(sessionKey: string): string {
  if (!sessionKey.trim()) throw new Error("sessionKey must be non-empty");
  return createHash("sha256").update(sessionKey, "utf8").digest("hex");
}

function parseRecord<TBatch>(value: unknown, agentId: string): DurableQueueRecord<TBatch> {
  if (!isObject(value) || value.version !== JOURNAL_VERSION) {
    throw new Error("capture journal contains an invalid queue record");
  }
  if (
    value.agentId !== agentId ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    typeof value.captureId !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.captureId) ||
    typeof value.enqueuedAt !== "number" ||
    !Number.isFinite(value.enqueuedAt)
  ) {
    throw new Error("capture journal queue record identity is invalid");
  }
  return {
    version: JOURNAL_VERSION,
    sequence: value.sequence,
    agentId,
    captureId: value.captureId,
    enqueuedAt: value.enqueuedAt,
    payload: value.payload as TBatch,
  };
}

function parseSession<TState, TBatch>(
  value: unknown,
  expectedAgentId: string,
  expectedSessionKey: string,
): JournalSession<TState, TBatch> {
  if (
    !isObject(value) ||
    value.version !== JOURNAL_VERSION ||
    value.agentId !== expectedAgentId ||
    value.sessionKey !== expectedSessionKey ||
    !("committed" in value)
  ) {
    throw new Error(
      `capture journal identity/schema mismatch for ${expectedAgentId}/${expectedSessionKey}`,
    );
  }

  let pending: JournalSession<TState, TBatch>["pending"];
  if (value.pending !== undefined) {
    if (
      !isObject(value.pending) ||
      typeof value.pending.transactionId !== "string" ||
      value.pending.transactionId.trim() === "" ||
      !("finalState" in value.pending) ||
      !Array.isArray(value.pending.records)
    ) {
      throw new Error(
        `capture journal contains an invalid pending transaction for ${expectedAgentId}/${expectedSessionKey}`,
      );
    }
    pending = {
      transactionId: value.pending.transactionId,
      finalState: value.pending.finalState as TState,
      records: value.pending.records.map((record) => parseRecord<TBatch>(record, expectedAgentId)),
    };
  }

  return {
    version: JOURNAL_VERSION,
    agentId: expectedAgentId,
    sessionKey: expectedSessionKey,
    committed: value.committed as TState,
    ...(pending ? { pending } : {}),
  };
}

/**
 * Small per-session write-ahead journal bridging transcript state and disk FIFO.
 *
 * One capture observation can do two things at once: advance the durable transcript
 * cursor/active partial buffer and publish zero or more full batches. Those effects
 * must be atomic from the point of view of crash recovery. The protocol is:
 *
 * 1. reserve queue sequence numbers (gaps are harmless);
 * 2. fsync a session intent containing the final state and complete queue records;
 * 3. fsync every queue record;
 * 4. atomically replace the session file with the final committed state.
 *
 * A crash at 1 leaves only harmless unused sequence numbers. A crash at 2 or 3 is
 * completed by `recoverAll()` before delivery starts. A crash after 4 has both the
 * cursor and all batches durable. The backlog itself never lives in this journal,
 * so session writes remain bounded even when the FIFO grows to many gigabytes.
 */
export class DurableCaptureJournal {
  readonly queue: DurableQueueStore;

  constructor(readonly root: string) {
    this.queue = new DurableQueueStore(root);
    mkdirSync(join(root, SESSIONS_DIR), { recursive: true, mode: 0o700 });
  }

  private sessionPath(agentId: string, sessionKey: string): string {
    return join(
      this.root,
      SESSIONS_DIR,
      durableAgentKey(agentId),
      `${sessionKeyHash(sessionKey)}.json`,
    );
  }

  private readRaw<TState, TBatch>(
    agentId: string,
    sessionKey: string,
  ): JournalSession<TState, TBatch> | undefined {
    const path = this.sessionPath(agentId, sessionKey);
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parseSession<TState, TBatch>(value, agentId, sessionKey);
  }

  /** Read committed state. Pending transactions are completed first. */
  read<TState, TBatch>(
    agentId: string,
    sessionKey: string,
  ): JournalSession<TState, TBatch> | undefined {
    const current = this.readRaw<TState, TBatch>(agentId, sessionKey);
    if (!current) return undefined;
    return current.pending ? this.finishPending(current) : current;
  }

  /**
   * Atomically advance one session and enqueue its newly completed batches.
   * `initialState` is used only when this is the session's first durable observation.
   */
  commit<TState, TBatch>(params: {
    agentId: string;
    sessionKey: string;
    initialState: TState;
    finalState: TState;
    batches: readonly JournalBatch<TBatch>[];
  }): JournalSession<TState, TBatch> {
    const existing = this.read<TState, TBatch>(params.agentId, params.sessionKey);
    const committed = existing?.committed ?? params.initialState;

    if (params.batches.length === 0) {
      const final: JournalSession<TState, TBatch> = {
        version: JOURNAL_VERSION,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        committed: params.finalState,
      };
      writeJsonAtomic(this.sessionPath(params.agentId, params.sessionKey), final);
      return final;
    }

    const records = params.batches.map((batch) => ({
      version: JOURNAL_VERSION,
      sequence: this.queue.allocateSequence(params.agentId),
      agentId: params.agentId,
      captureId: batch.captureId,
      enqueuedAt: batch.enqueuedAt,
      payload: batch.payload,
    })) satisfies DurableQueueRecord<TBatch>[];

    const intent: JournalSession<TState, TBatch> = {
      version: JOURNAL_VERSION,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      committed,
      pending: {
        transactionId: randomUUID(),
        finalState: params.finalState,
        records,
      },
    };
    writeJsonAtomic(this.sessionPath(params.agentId, params.sessionKey), intent);
    return this.finishPending(intent);
  }

  private finishPending<TState, TBatch>(
    session: JournalSession<TState, TBatch>,
  ): JournalSession<TState, TBatch> {
    const pending = session.pending;
    if (!pending) return session;

    for (const record of pending.records) this.queue.publish(record);

    const final: JournalSession<TState, TBatch> = {
      version: JOURNAL_VERSION,
      agentId: session.agentId,
      sessionKey: session.sessionKey,
      committed: pending.finalState,
    };
    writeJsonAtomic(this.sessionPath(session.agentId, session.sessionKey), final);
    return final;
  }

  /** Complete every fsynced intent before any queue worker is allowed to start. */
  recoverAll(): { sessions: number; transactions: number; records: number } {
    const sessionsRoot = join(this.root, SESSIONS_DIR);
    if (!existsSync(sessionsRoot)) return { sessions: 0, transactions: 0, records: 0 };

    let sessions = 0;
    let transactions = 0;
    let records = 0;
    for (const agentDirName of readdirSync(sessionsRoot)) {
      const agentDir = join(sessionsRoot, agentDirName);
      for (const fileName of readdirSync(agentDir)) {
        if (!fileName.endsWith(".json")) continue;
        const path = join(agentDir, fileName);
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (
          !isObject(raw) ||
          typeof raw.agentId !== "string" ||
          typeof raw.sessionKey !== "string"
        ) {
          throw new Error(`capture journal contains invalid session file ${path}`);
        }
        if (
          durableAgentKey(raw.agentId) !== agentDirName ||
          `${sessionKeyHash(raw.sessionKey)}.json` !== fileName
        ) {
          throw new Error(`capture journal session path does not match its identity: ${path}`);
        }

        const session = parseSession<unknown, unknown>(raw, raw.agentId, raw.sessionKey);
        sessions += 1;
        if (session.pending) {
          transactions += 1;
          records += session.pending.records.length;
          this.finishPending(session);
        }
      }
    }
    return { sessions, transactions, records };
  }
}
