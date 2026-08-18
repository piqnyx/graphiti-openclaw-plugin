import type { AgentActors } from "./config.js";
import { DEFAULT_ACTORS } from "./config.js";
import { CHECK_INTERVAL_SEC, MIN_BUFFER_TIMEOUT_SEC } from "./capture-constants.js";

export { CHECK_INTERVAL_SEC, MIN_BUFFER_TIMEOUT_SEC } from "./capture-constants.js";

export type MessageRole = "user" | "assistant";

export type BufferMessage = {
  role: MessageRole;
  text: string;
};

export type EpisodeJson = {
  participants: { user: string; assistant: string };
  messages: BufferMessage[];
};

export type Buffer = {
  sessionKey: string;
  messages: BufferMessage[];
  episode: EpisodeJson;
  createdAt: number;
  lastActivityAt: number;
};

export type FlushReason = "limit" | "timeout";

/** Stable identity reserved for a queue head before its first side effect. */
export type EpisodeIdentity = {
  uuid: string;
  name: string;
  batchNumber: number;
  previousEpisodeUuid?: string;
  submittedAt: number;
};

export type QueueEntry = {
  buffer: Buffer;
  enqueuedAt: number;
  reason: FlushReason;
  episode?: EpisodeIdentity;
  /** Set only for identities restored from the spool; cleared once reconciled. */
  identityRestored?: boolean;
};

export type AgentCaptureState = {
  agentId: string;
  activeBuffers: Map<string, Buffer>;
  queue: QueueEntry[];
  processing: boolean;
  retryAfter: number;
  failureActive: boolean;
};

export type PersistedBuffer = {
  sessionKey: string;
  participants: { user: string; assistant: string };
  messages: BufferMessage[];
  createdAt: number;
  lastActivityAt: number;
};

export type PersistedQueueEntry = {
  buffer: PersistedBuffer;
  enqueuedAt: number;
  reason: FlushReason;
  episode?: EpisodeIdentity;
};

export type PersistedAgentCaptureState = {
  agentId: string;
  activeBuffers: PersistedBuffer[];
  queue: PersistedQueueEntry[];
};

/** Engine-owned part of the durable capture state; the spool file owns schema versioning. */
export type BufferEngineSnapshot = {
  agents: PersistedAgentCaptureState[];
};

export type AgentSink = (
  agentId: string,
  entry: QueueEntry,
  reason: FlushReason,
) => Promise<void>;

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
    episode: {
      participants: { ...buffer.participants },
      messages,
    },
    createdAt: buffer.createdAt,
    lastActivityAt: buffer.lastActivityAt,
  };
}

/**
 * Per-session buffers feeding one FIFO per agent.
 *
 * The disk checkpoint is the authority. No remote side effect starts until the
 * state that describes it is durable, and no later queue head starts until the
 * checkpoint removing a committed predecessor succeeds. This is deliberately
 * slower than an in-memory queue and deliberately much harder to corrupt.
 */
export class BufferEngine {
  private readonly captureStates = new Map<string, AgentCaptureState>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly bufferTimeoutMs: number;
  private readonly pendingPumps = new Set<string>();
  private stopped = false;
  private persistFailureActive = false;
  private bulkCheckpointScheduled = false;

  constructor(
    private readonly agents: Record<string, AgentActors>,
    private readonly bufferLimit: number,
    bufferTimeoutSec: number,
    private readonly sink: AgentSink,
    private readonly opts: {
      notifyError?: (agentId: string, sessionKey: string, reason: FlushReason, error: Error) => void;
      notifyRecovered?: (agentId: string, sessionKey: string, reason: FlushReason) => void;
      onStateChange?: (snapshot: BufferEngineSnapshot) => void;
      notifyPersistError?: (error: Error) => void;
      notifyPersistRecovered?: () => void;
      initialState?: BufferEngineSnapshot;
    } = {},
  ) {
    if (!Number.isInteger(bufferLimit) || bufferLimit < 1) {
      throw new Error("bufferLimit must be an integer >= 1 message");
    }
    if (!Number.isInteger(bufferTimeoutSec) || bufferTimeoutSec < MIN_BUFFER_TIMEOUT_SEC) {
      throw new Error(`bufferTimeout must be an integer >= ${MIN_BUFFER_TIMEOUT_SEC} seconds`);
    }

    this.bufferTimeoutMs = bufferTimeoutSec * 1000;
    if (opts.initialState) this.restore(opts.initialState);

    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => {
        this.opts.notifyError?.("__tick__", "", "timeout", asError(error));
      });
    }, CHECK_INTERVAL_SEC * 1000);
    this.timer.unref?.();
  }

  addMessage(agentId: string, sessionKey: string, role: MessageRole, text: string): void {
    if (this.stopped) throw new Error("cannot add capture messages after BufferEngine shutdown");
    this.appendMessage(agentId, sessionKey, role, text);
    this.checkpoint();
  }

  /**
   * Add one observed transcript delta as one local transaction.
   *
   * The old implementation called addMessage() repeatedly, checkpointing after
   * every message. The transcript watermark is advanced by the caller only after
   * this method returns, so SIGKILL between those writes could leave messages on
   * disk with the old watermark; after restart the same messages were observed
   * again and duplicated/split across batches. Bulk additions therefore perform
   * no intermediate write. The caller's immediate checkpoint persists the whole
   * delta and its advanced watermark together. A microtask is only a fallback for
   * callers that do not explicitly checkpoint.
   */
  addMessages(agentId: string, sessionKey: string, messages: readonly BufferMessage[]): void {
    if (this.stopped) throw new Error("cannot add capture messages after BufferEngine shutdown");
    for (const message of messages) {
      this.appendMessage(agentId, sessionKey, message.role, message.text);
    }
    this.scheduleBulkCheckpoint();
  }

  private appendMessage(agentId: string, sessionKey: string, role: MessageRole, text: string): void {
    const clean = text.trim();
    if (!clean) return;

    const agent = this.ensureAgent(agentId);
    let buffer = agent.activeBuffers.get(sessionKey);
    if (!buffer) {
      buffer = this.createBuffer(sessionKey, agentId);
      agent.activeBuffers.set(sessionKey, buffer);
    }

    const now = Date.now();

    if (now - buffer.lastActivityAt >= this.bufferTimeoutMs && this.isNonEmpty(buffer)) {
      agent.queue.push({ buffer, enqueuedAt: now, reason: "timeout" });
      this.pendingPumps.add(agentId);
      buffer = this.createBuffer(sessionKey, agentId);
      agent.activeBuffers.set(sessionKey, buffer);
    }

    buffer.messages.push({ role, text: clean });
    buffer.lastActivityAt = now;

    if (buffer.messages.length >= this.bufferLimit) {
      agent.queue.push({ buffer, enqueuedAt: now, reason: "limit" });
      agent.activeBuffers.set(sessionKey, this.createBuffer(sessionKey, agentId));
      this.pendingPumps.add(agentId);
    }
  }

  private scheduleBulkCheckpoint(): void {
    if (this.bulkCheckpointScheduled) return;
    this.bulkCheckpointScheduled = true;
    queueMicrotask(() => {
      this.bulkCheckpointScheduled = false;
      // An explicit caller checkpoint normally ran already. Calling this again is
      // harmless and gives direct addMessages() users the same durability contract.
      this.checkpoint();
    });
  }

  private actorsFor(agentId: string): AgentActors {
    return this.agents[agentId] ?? DEFAULT_ACTORS;
  }

  private createBuffer(sessionKey: string, agentId: string): Buffer {
    const now = Date.now();
    const actors = this.actorsFor(agentId);
    const episode: EpisodeJson = {
      participants: { user: actors.user, assistant: actors.assistant },
      messages: [],
    };
    return {
      sessionKey,
      messages: episode.messages,
      episode,
      createdAt: now,
      lastActivityAt: now,
    };
  }

  private isNonEmpty(buffer: Buffer): boolean {
    return buffer.messages.length > 0;
  }

  private ensureAgent(agentId: string): AgentCaptureState {
    let agent = this.captureStates.get(agentId);
    if (!agent) {
      agent = {
        agentId,
        activeBuffers: new Map(),
        queue: [],
        processing: false,
        retryAfter: 0,
        failureActive: false,
      };
      this.captureStates.set(agentId, agent);
    }
    return agent;
  }

  private restore(snapshot: BufferEngineSnapshot): void {
    for (const persisted of snapshot.agents) {
      const agent = this.ensureAgent(persisted.agentId);
      for (const storedBuffer of persisted.activeBuffers) {
        const buffer = restoreBuffer(storedBuffer);
        if (!this.isNonEmpty(buffer)) continue;
        if (agent.activeBuffers.has(buffer.sessionKey)) {
          throw new Error(
            `capture snapshot contains duplicate active buffer for ${persisted.agentId}/${buffer.sessionKey}`,
          );
        }
        agent.activeBuffers.set(buffer.sessionKey, buffer);
      }
      agent.queue.push(
        ...persisted.queue
          .filter((entry) => entry.buffer.messages.length > 0)
          .map((entry) => ({
            buffer: restoreBuffer(entry.buffer),
            enqueuedAt: entry.enqueuedAt,
            reason: entry.reason,
            ...(entry.episode
              ? { episode: { ...entry.episode }, identityRestored: true }
              : {}),
          })),
      );
      if (agent.queue.length > 0) this.pendingPumps.add(agent.agentId);
    }
  }

  /** Start retry/timeout processing for state restored before plugin hooks became active. */
  resumeRestored(): void {
    if (this.stopped) return;
    void this.tick().catch((error: unknown) => {
      this.opts.notifyError?.("__tick__", "", "timeout", asError(error));
    });
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;

    const now = Date.now();
    let changed = false;
    for (const agent of this.captureStates.values()) {
      for (const [sessionKey, buffer] of agent.activeBuffers) {
        if (!this.isNonEmpty(buffer)) continue;
        if (now - buffer.lastActivityAt >= this.bufferTimeoutMs) {
          agent.activeBuffers.delete(sessionKey);
          agent.queue.push({ buffer, enqueuedAt: now, reason: "timeout" });
          this.pendingPumps.add(agent.agentId);
          changed = true;
        }
      }
    }

    // A previous disk error is retried even if no new mutation happened. No queue
    // is allowed to advance until the authoritative checkpoint is writable again.
    const durable = changed || this.persistFailureActive ? this.persistState() : true;
    if (!durable) return;

    this.flushPendingPumps();
    for (const agent of this.captureStates.values()) void this.pump(agent);
  }

  private async pump(agent: AgentCaptureState): Promise<void> {
    if (
      this.stopped ||
      this.persistFailureActive ||
      agent.processing ||
      Date.now() < agent.retryAfter
    ) {
      return;
    }

    agent.processing = true;
    try {
      while (!this.stopped && !this.persistFailureActive && agent.queue.length > 0) {
        const entry = agent.queue[0]!;
        const reason = entry.reason;
        try {
          await this.sink(agent.agentId, entry, reason);
        } catch (error) {
          agent.retryAfter = Date.now() + CHECK_INTERVAL_SEC * 1000;
          if (!agent.failureActive) {
            this.opts.notifyError?.(agent.agentId, entry.buffer.sessionKey, reason, asError(error));
          }
          agent.failureActive = true;
          break;
        }

        // shutdown/hot-reload may have happened while the remote call was in
        // flight. Leaving the committed head on disk is safe: the next process
        // confirms its UUID and removes it without repeating the graph mutation.
        if (this.stopped) {
          this.persistState();
          break;
        }

        agent.queue.shift();
        // Do not expose the next head remotely until removal of the committed
        // predecessor is durable. If this write fails the old disk image still
        // contains the predecessor, which is exactly the recoverable state.
        if (!this.persistState()) break;

        if (agent.failureActive) {
          this.opts.notifyRecovered?.(agent.agentId, entry.buffer.sessionKey, reason);
        }
        agent.failureActive = false;
        agent.retryAfter = 0;
      }
    } finally {
      agent.processing = false;
    }
  }

  private flushPendingPumps(): void {
    if (this.stopped || this.persistFailureActive) return;
    const ids = [...this.pendingPumps];
    this.pendingPumps.clear();
    for (const agentId of ids) {
      const agent = this.captureStates.get(agentId);
      if (agent) void this.pump(agent);
    }
  }

  queueLength(): number {
    let total = 0;
    for (const state of this.captureStates.values()) total += state.queue.length;
    return total;
  }

  activeBufferCount(agentId: string): number {
    return this.captureStates.get(agentId)?.activeBuffers.size ?? 0;
  }

  snapshot(): BufferEngineSnapshot {
    const agents: PersistedAgentCaptureState[] = [];
    for (const state of this.captureStates.values()) {
      const activeBuffers = [...state.activeBuffers.values()]
        .filter((buffer) => this.isNonEmpty(buffer))
        .map(persistBuffer);
      const queue = state.queue.map((entry) => ({
        buffer: persistBuffer(entry.buffer),
        enqueuedAt: entry.enqueuedAt,
        reason: entry.reason,
        ...(entry.episode ? { episode: { ...entry.episode } } : {}),
      }));
      if (activeBuffers.length === 0 && queue.length === 0) continue;
      agents.push({ agentId: state.agentId, activeBuffers, queue });
    }
    return { agents };
  }

  isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Persist all local capture state first, then release any queue head that became
   * eligible. Callers use this after advancing transcript watermarks or reserving
   * an episode identity so those mutations share the same durable boundary.
   */
  checkpoint(): void {
    if (this.persistState()) this.flushPendingPumps();
  }

  /**
   * Return whether the current in-memory state is durably represented on disk.
   * A write failure never starts/continues remote delivery; future mutations and
   * the periodic tick keep retrying the checkpoint until it recovers.
   */
  private persistState(): boolean {
    const onStateChange = this.opts.onStateChange;
    if (!onStateChange) return true;
    try {
      onStateChange(this.snapshot());
    } catch (error) {
      if (!this.persistFailureActive) {
        this.persistFailureActive = true;
        this.opts.notifyPersistError?.(asError(error));
      }
      return false;
    }
    if (this.persistFailureActive) {
      this.persistFailureActive = false;
      this.opts.notifyPersistRecovered?.();
    }
    return true;
  }

  async shutdown(graceMs = 4_000): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      clearInterval(this.timer);
      this.persistState();
    }

    const deadline = Date.now() + Math.max(0, graceMs);
    while ([...this.captureStates.values()].some((state) => state.processing)) {
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.persistState();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.persistState();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
