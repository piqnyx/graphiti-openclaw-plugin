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
  hydrated: boolean;
};

/**
 * Sessions whose sequence state is kept in memory. Eviction is safe: an evicted
 * session is simply hydrated from Graphiti again before its next batch. A
 * session with a pending batch is never evicted, because its reserved identity
 * only exists here and in the spool.
 */
export const MAX_TRACKED_SEQUENCES = 512;

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

  /**
   * Re-adopt an episode identity that was reserved before a restart, so the
   * replay of an unconfirmed batch reuses the same UUID, name and predecessor
   * instead of minting a second episode for the same messages.
   *
   * Returns false when Graphiti has moved past that batch number or chained a
   * different predecessor; the caller then falls back to a fresh reservation.
   */
  adoptPending(agentId: string, sessionKey: string, prepared: PreparedEpisodeSequence): boolean {
    const state = this.getState(agentId, sessionKey);
    if (state.pending) {
      throw new Error(`cannot adopt an episode identity over a pending batch for ${agentId}/${sessionKey}`);
    }
    if (prepared.batchNumber !== state.acceptedBatches + 1) return false;
    if (prepared.sagaPreviousEpisodeUuid !== state.lastEpisodeUuid) return false;

    state.pending = {
      ...prepared,
      previousEpisodeUuids: [...prepared.previousEpisodeUuids],
    };
    return true;
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
    state.hydrated = true;
  }

  snapshot(agentId: string, sessionKey: string): Readonly<SessionSequenceState> {
    const state = this.getState(agentId, sessionKey);
    return {
      acceptedBatches: state.acceptedBatches,
      lastEpisodeUuid: state.lastEpisodeUuid,
      pending: state.pending ? { ...state.pending, previousEpisodeUuids: [...state.pending.previousEpisodeUuids] } : undefined,
      hydrated: state.hydrated,
    };
  }

  /**
   * True once this process learned the session's position in its saga. Kept
   * here rather than in a parallel set so hydration state and sequence state
   * can never drift apart or be evicted independently.
   */
  isHydrated(agentId: string, sessionKey: string): boolean {
    return this.agents.get(agentId)?.get(sessionKey)?.hydrated ?? false;
  }

  private getState(agentId: string, sessionKey: string): SessionSequenceState {
    let sessions = this.agents.get(agentId);
    if (!sessions) {
      sessions = new Map();
      this.agents.set(agentId, sessions);
    }
    let state = sessions.get(sessionKey);
    if (!state) {
      state = { acceptedBatches: 0, hydrated: false };
      sessions.set(sessionKey, state);
      this.evictColdSessions();
    } else {
      // Re-insert so Map order stays least-recently-used first.
      sessions.delete(sessionKey);
      sessions.set(sessionKey, state);
    }
    return state;
  }

  private evictColdSessions(): void {
    let tracked = 0;
    for (const sessions of this.agents.values()) tracked += sessions.size;
    if (tracked <= MAX_TRACKED_SEQUENCES) return;

    for (const [agentId, sessions] of this.agents) {
      for (const [sessionKey, state] of sessions) {
        if (tracked <= MAX_TRACKED_SEQUENCES) return;
        if (state.pending) continue;
        sessions.delete(sessionKey);
        tracked -= 1;
      }
      if (sessions.size === 0) this.agents.delete(agentId);
    }
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
