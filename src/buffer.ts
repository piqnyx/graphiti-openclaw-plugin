import type { CompletedTurn, FlushReason } from "./types.js";

type TimerHandle = ReturnType<typeof setTimeout>;

type BufferState = {
  turns: CompletedTurn[];
  timer?: TimerHandle;
  flushTail: Promise<void>;
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

  constructor(
    private readonly threshold: number,
    private readonly idleFlushMs: number,
    private readonly flushBatch: FlushBatch,
    private readonly logger: BufferLogger = {},
  ) {}

  add(agentId: string, turn: CompletedTurn): void {
    const state = this.stateFor(agentId);
    state.turns.push(turn);
    this.logger.onBuffered?.(agentId, state.turns.length);
    this.armIdle(agentId, state);

    if (state.turns.length >= this.threshold) {
      void this.enqueueFlush(agentId, "threshold");
    }
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
      state = { turns: [], flushTail: Promise.resolve() };
      this.states.set(agentId, state);
    }
    return state;
  }

  private armIdle(agentId: string, state: BufferState): void {
    if (state.timer !== undefined) clearTimeout(state.timer);
    if (state.turns.length === 0) {
      state.timer = undefined;
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.enqueueFlush(agentId, "idle");
    }, this.idleFlushMs);
  }

  private enqueueFlush(agentId: string, reason: FlushReason): Promise<void> {
    const state = this.stateFor(agentId);
    const run = state.flushTail.then(() => this.flushOnce(agentId, state, reason));
    state.flushTail = run.catch((error) => {
      this.logger.onFlushError?.(agentId, reason, error);
    });
    return run;
  }

  private async flushOnce(
    agentId: string,
    state: BufferState,
    reason: FlushReason,
  ): Promise<void> {
    if (state.turns.length === 0) return;

    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }

    const batch = state.turns.splice(0, state.turns.length);
    try {
      await this.flushBatch(agentId, batch, reason);
    } catch (error) {
      state.turns.unshift(...batch);
      this.armIdle(agentId, state);
      throw error;
    }

    if (state.turns.length >= this.threshold) {
      void this.enqueueFlush(agentId, "threshold");
    } else {
      this.armIdle(agentId, state);
    }
  }
}
