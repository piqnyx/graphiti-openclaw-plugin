import type { CompletedTurn, FlushReason } from "./types.js";

type TimerHandle = ReturnType<typeof setTimeout>;

type BufferState = {
  turns: CompletedTurn[];
  lastBufferedAt?: number;
  version: number;
  retryBlocked: boolean;
  flushPromise?: Promise<void>;
};

export type FlushBatch = (
  agentId: string,
  turns: readonly CompletedTurn[],
  reason: FlushReason,
) => Promise<void>;

export type BufferLogger = {
  onBuffered?: (agentId: string, turns: number) => void;
  onFlushError?: (agentId: string, reason: FlushReason, error: unknown) => void;
};

export class AgentTurnBuffer {
  private readonly states = new Map<string, BufferState>();
  private idleTimer?: TimerHandle;

  constructor(
    private readonly threshold: number,
    private readonly idleFlushMs: number,
    private readonly flushBatch: FlushBatch,
    private readonly logger: BufferLogger = {},
  ) {}

  add(agentId: string, turn: CompletedTurn): void {
    const state = this.stateFor(agentId);
    state.turns.push(turn);
    state.version += 1;
    state.lastBufferedAt = Date.now();
    state.retryBlocked = false;
    this.logger.onBuffered?.(agentId, state.turns.length);

    if (state.turns.length >= this.threshold) {
      void this.enqueueFlush(agentId, "threshold");
    }
    this.scheduleIdleSweep();
  }

  bufferedTurns(agentId: string): number {
    return this.states.get(agentId)?.turns.length ?? 0;
  }

  async flush(agentId: string, reason: FlushReason): Promise<void> {
    await this.enqueueFlush(agentId, reason);
  }

  private stateFor(agentId: string): BufferState {
    let state = this.states.get(agentId);
    if (!state) {
      state = { turns: [], version: 0, retryBlocked: false };
      this.states.set(agentId, state);
    }
    return state;
  }

  private scheduleIdleSweep(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }

    const now = Date.now();
    let nextDueAt: number | undefined;
    for (const state of this.states.values()) {
      if (
        state.turns.length === 0 ||
        state.lastBufferedAt === undefined ||
        state.retryBlocked ||
        state.flushPromise
      ) {
        continue;
      }
      const dueAt = state.lastBufferedAt + this.idleFlushMs;
      if (nextDueAt === undefined || dueAt < nextDueAt) nextDueAt = dueAt;
    }

    if (nextDueAt === undefined) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.runIdleSweep();
    }, Math.max(0, nextDueAt - now));
  }

  private runIdleSweep(): void {
    const now = Date.now();
    for (const [agentId, state] of this.states.entries()) {
      if (
        state.turns.length === 0 ||
        state.lastBufferedAt === undefined ||
        state.retryBlocked ||
        state.flushPromise
      ) {
        continue;
      }
      if (now - state.lastBufferedAt >= this.idleFlushMs) {
        void this.enqueueFlush(agentId, "idle");
      }
    }
    this.scheduleIdleSweep();
  }

  private enqueueFlush(agentId: string, reason: FlushReason): Promise<void> {
    const state = this.stateFor(agentId);
    if (state.flushPromise) return state.flushPromise;
    if (state.turns.length === 0) return Promise.resolve();

    const flushPromise = this.flushOnce(agentId, state, reason)
      .catch((error) => {
        this.logger.onFlushError?.(agentId, reason, error);
        throw error;
      })
      .finally(() => {
        state.flushPromise = undefined;
        if (!state.retryBlocked && state.turns.length >= this.threshold) {
          void this.enqueueFlush(agentId, "threshold");
        }
        this.scheduleIdleSweep();
      });
    state.flushPromise = flushPromise;
    this.scheduleIdleSweep();
    return flushPromise;
  }

  private async flushOnce(
    agentId: string,
    state: BufferState,
    reason: FlushReason,
  ): Promise<void> {
    const versionAtStart = state.version;
    const batch = state.turns.splice(0, state.turns.length);
    try {
      await this.flushBatch(agentId, batch, reason);
    } catch (error) {
      state.turns.unshift(...batch);
      state.retryBlocked = state.version === versionAtStart;
      throw error;
    }
  }
}
