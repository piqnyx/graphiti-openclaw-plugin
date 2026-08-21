import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Buffer,
  BufferMessage,
  EpisodeIdentity,
  FlushReason,
  PersistedBuffer,
  QueueEntry,
} from "./buffer.js";
import { parseCursor, type SessionCursor } from "./capture-cursor.js";
import { CHECK_INTERVAL_SEC, MIN_BUFFER_TIMEOUT_SEC } from "./capture-constants.js";
import type { AgentActors } from "./config.js";
import { DEFAULT_ACTORS } from "./config.js";
import {
  DurableCaptureJournal,
  type JournalBatch,
} from "./durable-capture-journal.js";
import type { DurableQueueRecord } from "./durable-queue-store.js";

export type DurableCaptureSessionState = {
  cursor?: SessionCursor;
  active?: PersistedBuffer;
};

export type DurableCaptureQueuePayload = {
  buffer: PersistedBuffer;
  reason: FlushReason;
  episode?: EpisodeIdentity;
};

export type DurableSinkControls = {
  sequence: number;
  captureId: string;
  /** Persist mutations to this exact head, notably reserved Graphiti identity. */
  checkpoint: () => void;
};

export type DurableAgentSink = (
  agentId: string,
  entry: QueueEntry,
  reason: FlushReason,
  controls: DurableSinkControls,
) => Promise<void>;

type KnownSession = { agentId: string; sessionKey: string; lastActivityAt: number };

type EngineOptions = {
  notifyError?: (agentId: string, sessionKey: string, reason: FlushReason, error: Error) => void;
  notifyRecovered?: (agentId: string, sessionKey: string, reason: FlushReason) => void;
  notifyPersistError?: (error: Error) => void;
  notifyPersistRecovered?: () => void;
};

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function cloneMessages(messages: readonly BufferMessage[]): BufferMessage[] {
  return messages.map((message) => ({ ...message }));
}

function persistBuffer(buffer: Buffer): PersistedBuffer {
  return {
    sessionKey: buffer.sessionKey,
    participants: { ...buffer.episode.participants },
    messages: cloneMessages(buffer.messages),
    createdAt: buffer.createdAt,
    lastActivityAt: buffer.lastActivityAt,
  };
}

function restoreBuffer(buffer: PersistedBuffer): Buffer {
  const messages = cloneMessages(buffer.messages);
  return {
    sessionKey: buffer.sessionKey,
    messages,
    episode: { participants: { ...buffer.participants }, messages },
    createdAt: buffer.createdAt,
    lastActivityAt: buffer.lastActivityAt,
  };
}

function captureId(agentId: string, payload: DurableCaptureQueuePayload): string {
  const hash = createHash("sha256");
  hash.update(agentId, "utf8");
  hash.update("\0", "utf8");
  hash.update(payload.buffer.sessionKey, "utf8");
  hash.update("\0", "utf8");
  hash.update(JSON.stringify(payload), "utf8");
  return hash.digest("hex");
}

function sessionMapKey(agentId: string, sessionKey: string): string {
  return JSON.stringify([agentId, sessionKey]);
}

/**
 * Disk-authoritative capture engine.
 *
 * Active partial buffers are one small journal file per session. Completed batches
 * are segmented immutable queue files and are never copied back into session state.
 * Consequently backlog size is bounded by disk, not process RAM and not O(backlog)
 * checkpoint rewrites. Only one batch per agent is read for delivery at a time.
 *
 * Transcript movement is part of the same durability boundary: the candidate cursor
 * is committed in the session journal together with any batches produced by that
 * observation. If the local transaction fails, the in-memory tracker is rolled back
 * so the same messages are offered again instead of silently skipped.
 */
export class DurableBufferEngine {
  readonly journal: DurableCaptureJournal;
  private readonly bufferTimeoutMs: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly knownSessions = new Map<string, KnownSession>();
  private readonly processing = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  private readonly failureActive = new Set<string>();
  private stopped = false;
  private persistFailureActive = false;

  constructor(
    root: string,
    private readonly agents: Record<string, AgentActors>,
    private readonly bufferLimit: number,
    bufferTimeoutSec: number,
    private readonly sink: DurableAgentSink,
    private readonly opts: EngineOptions = {},
  ) {
    if (!Number.isInteger(bufferLimit) || bufferLimit < 1) {
      throw new Error("bufferLimit must be an integer >= 1 message");
    }
    if (!Number.isInteger(bufferTimeoutSec) || bufferTimeoutSec < MIN_BUFFER_TIMEOUT_SEC) {
      throw new Error(`bufferTimeout must be an integer >= ${MIN_BUFFER_TIMEOUT_SEC} seconds`);
    }
    this.bufferTimeoutMs = bufferTimeoutSec * 1000;
    this.journal = new DurableCaptureJournal(root);

    // An fsynced session intent is stronger than any in-memory state. Complete all
    // such local transactions before the first remote delivery can start.
    this.journal.recoverAll();
    this.discoverSessions();

    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => this.opts.notifyPersistError?.(asError(error)));
    }, CHECK_INTERVAL_SEC * 1000);
    this.timer.unref?.();

    for (const agentId of this.journal.queue.listAgents()) void this.pump(agentId);
  }

  private actorsFor(agentId: string): AgentActors {
    return this.agents[agentId] ?? DEFAULT_ACTORS;
  }

  private newBuffer(agentId: string, sessionKey: string, now: number): Buffer {
    const actors = this.actorsFor(agentId);
    const messages: BufferMessage[] = [];
    return {
      sessionKey,
      messages,
      episode: {
        participants: { user: actors.user, assistant: actors.assistant },
        messages,
      },
      createdAt: now,
      lastActivityAt: now,
    };
  }

  private sessionState(
    agentId: string,
    sessionKey: string,
  ): DurableCaptureSessionState {
    return (
      this.journal.read<DurableCaptureSessionState, DurableCaptureQueuePayload>(
        agentId,
        sessionKey,
      )?.committed ?? {}
    );
  }

  /**
   * How far this session has already been read, as last made durable.
   *
   * Read from disk on every call rather than cached in memory: the cursor is the
   * one piece of state whose staleness costs duplicated or skipped conversation,
   * and the file is authoritative even after a crash mid-turn.
   */
  sessionCursor(agentId: string, sessionKey: string): SessionCursor | undefined {
    return parseCursor(this.sessionState(agentId, sessionKey).cursor);
  }

  /** Make new conversation messages durable and move the session cursor with them. */
  ingest(
    agentId: string,
    sessionKey: string,
    messages: readonly BufferMessage[],
    cursor: SessionCursor,
  ): void {
    if (this.stopped) throw new Error("cannot add capture messages after DurableBufferEngine shutdown");

    // The capture observation has one logical time. Before this observation is
    // allowed to create a newer limit batch, every buffer of the same agent whose
    // inactivity deadline has already passed is detached in deadline order. This
    // closes the race where a late ticker could otherwise enqueue an older timeout
    // behind a newer batch from another dialog.
    const now = Date.now();
    this.expireDueSessions(agentId, now);

    const previous = this.sessionState(agentId, sessionKey);
    let active = previous.active ? restoreBuffer(previous.active) : undefined;
    const batches: JournalBatch<DurableCaptureQueuePayload>[] = [];

    const flush = (buffer: Buffer, reason: FlushReason, enqueuedAt: number): void => {
      if (buffer.messages.length === 0) return;
      const payload: DurableCaptureQueuePayload = { buffer: persistBuffer(buffer), reason };
      batches.push({ captureId: captureId(agentId, payload), enqueuedAt, payload });
    };

    for (const message of messages) {
      const text = message.text.trim();
      if (!text) continue;
      active ??= this.newBuffer(agentId, sessionKey, now);
      // The same turn, word for word, twice in one batch. It arrives that way from a
      // rewind -- the gateway repoints the session at a fresh one and the resent
      // message is genuinely new -- and equally from a run that failed before
      // replying, where the question simply gets asked again. The second kind leaves
      // no marker of any sort, so recognising the text is the only thing that catches
      // both.
      //
      // Only here, in the buffer nothing has been promised about yet. What has gone
      // to the queue has gone: the graph may already hold it, and a buffer that knew
      // better than the graph would be a worse problem than a repeated sentence.
      if (active.messages.some((held) => held.role === message.role && held.text === text)) {
        continue;
      }
      active.messages.push({ role: message.role, text });
      active.lastActivityAt = now;
      if (active.messages.length >= this.bufferLimit) {
        flush(active, "limit", now);
        active = undefined;
      }
    }

    const finalState: DurableCaptureSessionState = {
      cursor: { ...cursor, capturedEventIds: [...cursor.capturedEventIds] },
      ...(active && active.messages.length > 0 ? { active: persistBuffer(active) } : {}),
    };

    this.commitSession(agentId, sessionKey, previous, finalState, batches);
    this.updateKnownSession(agentId, sessionKey, finalState.active?.lastActivityAt);
    void this.pump(agentId);
  }

  /** Persist a read that produced no new messages, so the next one starts here. */
  checkpointCursor(agentId: string, sessionKey: string, cursor: SessionCursor): void {
    if (this.stopped) throw new Error("cannot checkpoint after DurableBufferEngine shutdown");
    const now = Date.now();
    this.expireDueSessions(agentId, now);
    const previous = this.sessionState(agentId, sessionKey);
    const finalState: DurableCaptureSessionState = {
      ...previous,
      cursor: { ...cursor, capturedEventIds: [...cursor.capturedEventIds] },
    };
    this.commitSession(agentId, sessionKey, previous, finalState, []);
    void this.pump(agentId);
  }

  /** Append a synthetic note without moving the OpenClaw transcript cursor. */
  appendSynthetic(agentId: string, sessionKey: string, message: BufferMessage): void {
    if (this.stopped) throw new Error("cannot add capture messages after DurableBufferEngine shutdown");
    const at = Date.now();
    this.expireDueSessions(agentId, at);
    const previous = this.sessionState(agentId, sessionKey);
    let active = previous.active ? restoreBuffer(previous.active) : undefined;
    const batches: JournalBatch<DurableCaptureQueuePayload>[] = [];

    active ??= this.newBuffer(agentId, sessionKey, at);
    const text = message.text.trim();
    if (text) active.messages.push({ role: message.role, text });
    active.lastActivityAt = at;
    if (active.messages.length >= this.bufferLimit) {
      const payload: DurableCaptureQueuePayload = { buffer: persistBuffer(active), reason: "limit" };
      batches.push({ captureId: captureId(agentId, payload), enqueuedAt: at, payload });
      active = undefined;
    }

    const finalState: DurableCaptureSessionState = {
      ...(previous.cursor
        ? { cursor: { ...previous.cursor, capturedEventIds: [...previous.cursor.capturedEventIds] } }
        : {}),
      ...(active && active.messages.length > 0 ? { active: persistBuffer(active) } : {}),
    };
    this.commitSession(agentId, sessionKey, previous, finalState, batches);
    this.updateKnownSession(agentId, sessionKey, finalState.active?.lastActivityAt);
    void this.pump(agentId);
  }

  private commitSession(
    agentId: string,
    sessionKey: string,
    previous: DurableCaptureSessionState,
    finalState: DurableCaptureSessionState,
    batches: readonly JournalBatch<DurableCaptureQueuePayload>[],
  ): void {
    try {
      this.journal.commit({
        agentId,
        sessionKey,
        initialState: previous,
        finalState,
        batches,
      });
      if (this.persistFailureActive) {
        this.persistFailureActive = false;
        this.opts.notifyPersistRecovered?.();
      }
    } catch (error) {
      if (!this.persistFailureActive) {
        this.persistFailureActive = true;
        this.opts.notifyPersistError?.(asError(error));
      }
      throw error;
    }
  }

  private updateKnownSession(agentId: string, sessionKey: string, lastActivityAt?: number): void {
    const key = sessionMapKey(agentId, sessionKey);
    if (lastActivityAt === undefined) {
      this.knownSessions.delete(key);
      return;
    }
    this.knownSessions.set(key, { agentId, sessionKey, lastActivityAt });
  }

  private timeoutDeadline(lastActivityAt: number): number {
    return lastActivityAt + this.bufferTimeoutMs;
  }

  /**
   * Detach every expired partial buffer for one agent in logical timeout order.
   *
   * A timeout batch is considered born at lastActivityAt + bufferTimeout, not when
   * the 30-second maintenance ticker happens to notice it. Re-reading durable state
   * before each detach makes the tiny in-memory timeout index advisory only. If any
   * commit fails, the caller aborts before it can enqueue newer work and ordering is
   * preserved across the retry/restart.
   */
  private expireDueSessions(agentId: string, now: number): void {
    const due = [...this.knownSessions.values()]
      .filter(
        (session) =>
          session.agentId === agentId && this.timeoutDeadline(session.lastActivityAt) <= now,
      )
      .sort((left, right) => {
        const deadlineOrder =
          this.timeoutDeadline(left.lastActivityAt) - this.timeoutDeadline(right.lastActivityAt);
        if (deadlineOrder !== 0) return deadlineOrder;
        return left.sessionKey.localeCompare(right.sessionKey);
      });

    for (const session of due) {
      const state = this.sessionState(session.agentId, session.sessionKey);
      const active = state.active;
      if (!active || active.messages.length === 0) {
        this.updateKnownSession(session.agentId, session.sessionKey, undefined);
        continue;
      }

      const deadline = this.timeoutDeadline(active.lastActivityAt);
      if (deadline > now) {
        // The durable file changed after this timeout-index entry was recorded.
        this.updateKnownSession(session.agentId, session.sessionKey, active.lastActivityAt);
        continue;
      }

      const payload: DurableCaptureQueuePayload = { buffer: active, reason: "timeout" };
      this.commitSession(
        session.agentId,
        session.sessionKey,
        state,
        state.cursor ? { cursor: state.cursor } : {},
        [{ captureId: captureId(session.agentId, payload), enqueuedAt: deadline, payload }],
      );
      this.updateKnownSession(session.agentId, session.sessionKey, undefined);
    }
  }

  /** Rebuild only the tiny timeout index; cursors are read from disk on demand. */
  private discoverSessions(): void {
    const sessionsRoot = join(this.journal.root, "sessions");
    if (!existsSync(sessionsRoot)) return;
    for (const agentDir of readdirSync(sessionsRoot)) {
      const path = join(sessionsRoot, agentDir);
      for (const file of readdirSync(path)) {
        if (!file.endsWith(".json")) continue;
        const raw = JSON.parse(readFileSync(join(path, file), "utf8")) as unknown;
        if (
          typeof raw !== "object" ||
          raw === null ||
          Array.isArray(raw) ||
          typeof (raw as { agentId?: unknown }).agentId !== "string" ||
          typeof (raw as { sessionKey?: unknown }).sessionKey !== "string"
        ) {
          throw new Error(`invalid durable capture session ${join(path, file)}`);
        }
        const agentId = (raw as { agentId: string }).agentId;
        const sessionKey = (raw as { sessionKey: string }).sessionKey;
        const state = this.sessionState(agentId, sessionKey);
        if (state.active?.messages.length) {
          this.updateKnownSession(agentId, sessionKey, state.active.lastActivityAt);
        }
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const agentIds = new Set<string>();
    for (const session of this.knownSessions.values()) agentIds.add(session.agentId);
    for (const agentId of agentIds) this.expireDueSessions(agentId, now);
    for (const agentId of this.journal.queue.listAgents()) void this.pump(agentId);
  }

  private restoreQueueEntry(record: DurableQueueRecord<DurableCaptureQueuePayload>): QueueEntry {
    return {
      buffer: restoreBuffer(record.payload.buffer),
      enqueuedAt: record.enqueuedAt,
      reason: record.payload.reason,
      ...(record.payload.episode ? { episode: { ...record.payload.episode }, identityRestored: true } : {}),
    };
  }

  private persistHead(
    agentId: string,
    record: DurableQueueRecord<DurableCaptureQueuePayload>,
    entry: QueueEntry,
  ): void {
    this.journal.queue.update<DurableCaptureQueuePayload>(agentId, record.sequence, (current) => ({
      ...current,
      payload: {
        buffer: persistBuffer(entry.buffer),
        reason: entry.reason,
        ...(entry.episode ? { episode: { ...entry.episode } } : {}),
      },
    }));
  }

  private async pump(agentId: string): Promise<void> {
    if (
      this.stopped ||
      this.persistFailureActive ||
      this.processing.has(agentId) ||
      Date.now() < (this.retryAfter.get(agentId) ?? 0)
    ) {
      return;
    }

    this.processing.add(agentId);
    try {
      while (!this.stopped && !this.persistFailureActive) {
        const record = this.journal.queue.peekHead<DurableCaptureQueuePayload>(agentId);
        if (!record) return;
        const entry = this.restoreQueueEntry(record);
        const reason = entry.reason;
        try {
          await this.sink(agentId, entry, reason, {
            sequence: record.sequence,
            captureId: record.captureId,
            checkpoint: () => this.persistHead(agentId, record, entry),
          });
        } catch (error) {
          this.retryAfter.set(agentId, Date.now() + CHECK_INTERVAL_SEC * 1000);
          if (!this.failureActive.has(agentId)) {
            this.opts.notifyError?.(agentId, entry.buffer.sessionKey, reason, asError(error));
          }
          this.failureActive.add(agentId);
          return;
        }

        if (this.stopped) return;
        this.journal.queue.removeHead(agentId, record.sequence);
        if (this.failureActive.delete(agentId)) {
          this.opts.notifyRecovered?.(agentId, entry.buffer.sessionKey, reason);
        }
        this.retryAfter.delete(agentId);
      }
    } finally {
      this.processing.delete(agentId);
    }
  }

  queueDepth(agentId: string): number {
    return this.journal.queue.approximateDepth(agentId);
  }

  activeBufferCount(agentId: string): number {
    let count = 0;
    for (const session of this.knownSessions.values()) if (session.agentId === agentId) count += 1;
    return count;
  }

  activeMessageCount(agentId: string): number {
    let count = 0;
    for (const session of this.knownSessions.values()) {
      if (session.agentId !== agentId) continue;
      count += this.sessionState(session.agentId, session.sessionKey).active?.messages.length ?? 0;
    }
    return count;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  async shutdown(graceMs = 4_000): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      clearInterval(this.timer);
    }
    const deadline = Date.now() + Math.max(0, graceMs);
    while (this.processing.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
