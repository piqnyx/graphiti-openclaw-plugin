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
import { CHECK_INTERVAL_SEC, MIN_BUFFER_TIMEOUT_SEC } from "./capture-constants.js";
import type { AgentActors } from "./config.js";
import { DEFAULT_ACTORS } from "./config.js";
import {
  DurableCaptureJournal,
  type JournalBatch,
} from "./durable-capture-journal.js";
import type { DurableQueueRecord } from "./durable-queue-store.js";
import type { SessionWatermark } from "./transcript-delta.js";

export type DurableCaptureSessionState = {
  watermark?: SessionWatermark;
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
 * Disk-authoritative capture engine intended to replace the monolithic JSON spool.
 *
 * Active partial buffers are one small journal file per session. Completed batches
 * are segmented immutable queue files and are never copied back into session state.
 * Consequently backlog size is bounded by disk, not process RAM and not O(backlog)
 * checkpoint rewrites. Only one batch per agent is read for delivery at a time.
 *
 * This class is intentionally introduced beside BufferEngine first. The old live
 * pipeline stays untouched until the new engine's crash/fault tests are green.
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
   * Durably ingest one transcript delta and its exact new cursor in one local transaction.
   * On return every message is either in the session's partial buffer or a disk FIFO file.
   */
  ingest(
    agentId: string,
    sessionKey: string,
    messages: readonly BufferMessage[],
    watermark: SessionWatermark,
  ): void {
    if (this.stopped) throw new Error("cannot add capture messages after DurableBufferEngine shutdown");

    const previous = this.sessionState(agentId, sessionKey);
    let active = previous.active ? restoreBuffer(previous.active) : undefined;
    const batches: JournalBatch<DurableCaptureQueuePayload>[] = [];
    const now = Date.now();

    const flush = (buffer: Buffer, reason: FlushReason, enqueuedAt: number): void => {
      if (buffer.messages.length === 0) return;
      const payload: DurableCaptureQueuePayload = { buffer: persistBuffer(buffer), reason };
      batches.push({ captureId: captureId(agentId, payload), enqueuedAt, payload });
    };

    for (const message of messages) {
      const text = message.text.trim();
      if (!text) continue;
      const at = Date.now();
      if (
        active &&
        active.messages.length > 0 &&
        at - active.lastActivityAt >= this.bufferTimeoutMs
      ) {
        flush(active, "timeout", at);
        active = undefined;
      }
      active ??= this.newBuffer(agentId, sessionKey, at);
      active.messages.push({ role: message.role, text });
      active.lastActivityAt = at;
      if (active.messages.length >= this.bufferLimit) {
        flush(active, "limit", at);
        active = undefined;
      }
    }

    const finalState: DurableCaptureSessionState = {
      watermark: { ...watermark, tailHashes: [...watermark.tailHashes] },
      ...(active && active.messages.length > 0 ? { active: persistBuffer(active) } : {}),
    };

    this.commitSession(agentId, sessionKey, previous, finalState, batches);
    const lastActivityAt = finalState.active?.lastActivityAt ?? now;
    this.updateKnownSession(agentId, sessionKey, finalState.active ? lastActivityAt : undefined);
    void this.pump(agentId);
  }

  /** Persist a cursor observation that produced no new messages. */
  checkpointWatermark(agentId: string, sessionKey: string, watermark: SessionWatermark): void {
    if (this.stopped) throw new Error("cannot checkpoint after DurableBufferEngine shutdown");
    const previous = this.sessionState(agentId, sessionKey);
    const finalState: DurableCaptureSessionState = {
      ...previous,
      watermark: { ...watermark, tailHashes: [...watermark.tailHashes] },
    };
    this.commitSession(agentId, sessionKey, previous, finalState, []);
  }

  /** Append a synthetic note without moving the OpenClaw transcript cursor. */
  appendSynthetic(agentId: string, sessionKey: string, message: BufferMessage): void {
    if (this.stopped) throw new Error("cannot add capture messages after DurableBufferEngine shutdown");
    const previous = this.sessionState(agentId, sessionKey);
    let active = previous.active ? restoreBuffer(previous.active) : undefined;
    const batches: JournalBatch<DurableCaptureQueuePayload>[] = [];
    const at = Date.now();

    if (active && active.messages.length > 0 && at - active.lastActivityAt >= this.bufferTimeoutMs) {
      const payload: DurableCaptureQueuePayload = { buffer: persistBuffer(active), reason: "timeout" };
      batches.push({ captureId: captureId(agentId, payload), enqueuedAt: at, payload });
      active = undefined;
    }
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
      ...(previous.watermark
        ? { watermark: { ...previous.watermark, tailHashes: [...previous.watermark.tailHashes] } }
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

  /** Rebuild only the tiny timeout index. Queue bodies remain on disk. */
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
    for (const session of [...this.knownSessions.values()]) {
      if (now - session.lastActivityAt < this.bufferTimeoutMs) continue;
      const state = this.sessionState(session.agentId, session.sessionKey);
      const active = state.active;
      if (!active || active.messages.length === 0) {
        this.updateKnownSession(session.agentId, session.sessionKey, undefined);
        continue;
      }
      if (now - active.lastActivityAt < this.bufferTimeoutMs) {
        this.updateKnownSession(session.agentId, session.sessionKey, active.lastActivityAt);
        continue;
      }
      const payload: DurableCaptureQueuePayload = { buffer: active, reason: "timeout" };
      this.commitSession(
        session.agentId,
        session.sessionKey,
        state,
        state.watermark ? { watermark: state.watermark } : {},
        [{ captureId: captureId(session.agentId, payload), enqueuedAt: now, payload }],
      );
      this.updateKnownSession(session.agentId, session.sessionKey, undefined);
      void this.pump(session.agentId);
    }
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
