import { randomUUID } from "node:crypto";

export type PreparedEpisodeSequence = {
  batchNumber: number;
  episodeUuid: string;
  name: string;
  previousEpisodeUuids: string[];
  sagaPreviousEpisodeUuid?: string;
};

type SessionSequenceState = {
  acceptedBatches: number;
  lastEpisodeUuid?: string;
  pending?: PreparedEpisodeSequence;
};

/**
 * Tracks Graphiti episode continuity independently for every agent + OpenClaw session.
 * The queue is per agent, but predecessor state must be per saga/session because
 * batches from multiple dialogs can be interleaved in that queue.
 *
 * prepare() reserves one stable caller-visible UUID and keeps returning the same
 * pending sequence until Graphiti accepts it. This makes transport retries
 * idempotent with respect to episode identity.
 */
export class EpisodeSequenceTracker {
  private readonly agents = new Map<string, Map<string, SessionSequenceState>>();

  prepare(agentId: string, sessionKey: string): PreparedEpisodeSequence {
    const state = this.getState(agentId, sessionKey);
    if (state.pending) return { ...state.pending, previousEpisodeUuids: [...state.pending.previousEpisodeUuids] };

    const batchNumber = state.acceptedBatches + 1;
    const previousEpisodeUuids = state.lastEpisodeUuid ? [state.lastEpisodeUuid] : [];
    const prepared: PreparedEpisodeSequence = {
      batchNumber,
      episodeUuid: randomUUID(),
      name: `${episodeNamePrefix(sessionKey)}-${batchNumber}`,
      previousEpisodeUuids,
      sagaPreviousEpisodeUuid: state.lastEpisodeUuid,
    };
    state.pending = prepared;
    return { ...prepared, previousEpisodeUuids: [...prepared.previousEpisodeUuids] };
  }

  accept(agentId: string, sessionKey: string, batchNumber: number, episodeUuid: string): void {
    if (!episodeUuid.trim()) throw new Error("Graphiti accepted episode UUID must be non-empty");
    const state = this.getState(agentId, sessionKey);
    const expected = state.acceptedBatches + 1;
    if (batchNumber !== expected) {
      throw new Error(`episode sequence out of order for ${agentId}/${sessionKey}: expected ${expected}, got ${batchNumber}`);
    }
    if (!state.pending) {
      throw new Error(`episode sequence has no pending batch for ${agentId}/${sessionKey}`);
    }
    if (state.pending.batchNumber !== batchNumber) {
      throw new Error(`episode sequence pending batch mismatch for ${agentId}/${sessionKey}`);
    }
    if (state.pending.episodeUuid !== episodeUuid) {
      throw new Error(
        `Graphiti accepted unexpected episode UUID for ${agentId}/${sessionKey}: expected ${state.pending.episodeUuid}, got ${episodeUuid}`,
      );
    }
    state.acceptedBatches = batchNumber;
    state.lastEpisodeUuid = episodeUuid;
    state.pending = undefined;
  }

  hydrate(agentId: string, sessionKey: string, acceptedBatches: number, lastEpisodeUuid?: string): void {
    if (!Number.isInteger(acceptedBatches) || acceptedBatches < 0) {
      throw new Error("acceptedBatches must be a non-negative integer");
    }
    if (acceptedBatches > 0 && !lastEpisodeUuid?.trim()) {
      throw new Error("lastEpisodeUuid is required when acceptedBatches > 0");
    }
    const state = this.getState(agentId, sessionKey);
    if (state.pending) throw new Error(`cannot hydrate sequence with a pending batch for ${agentId}/${sessionKey}`);
    state.acceptedBatches = acceptedBatches;
    state.lastEpisodeUuid = lastEpisodeUuid;
  }

  snapshot(agentId: string, sessionKey: string): Readonly<SessionSequenceState> {
    const state = this.getState(agentId, sessionKey);
    return {
      acceptedBatches: state.acceptedBatches,
      lastEpisodeUuid: state.lastEpisodeUuid,
      pending: state.pending ? { ...state.pending, previousEpisodeUuids: [...state.pending.previousEpisodeUuids] } : undefined,
    };
  }

  private getState(agentId: string, sessionKey: string): SessionSequenceState {
    let sessions = this.agents.get(agentId);
    if (!sessions) {
      sessions = new Map();
      this.agents.set(agentId, sessions);
    }
    let state = sessions.get(sessionKey);
    if (!state) {
      state = { acceptedBatches: 0 };
      sessions.set(sessionKey, state);
    }
    return state;
  }
}

/** Human-readable stable prefix: UUID session keys use their final 12-hex segment. */
export function episodeNamePrefix(sessionKey: string): string {
  const value = sessionKey.trim();
  const uuidMatches = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-([0-9a-f]{12})/gi);
  if (uuidMatches?.length) {
    return uuidMatches.at(-1)!.slice(-12).toLowerCase();
  }

  const lastPart = value.split(":").filter(Boolean).at(-1) ?? value;
  const safe = lastPart.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (safe || "session").slice(-32);
}
