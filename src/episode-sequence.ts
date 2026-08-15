export type PreparedEpisodeSequence = {
  batchNumber: number;
  name: string;
  previousEpisodeUuids: string[];
  sagaPreviousEpisodeUuid?: string;
};

type SessionSequenceState = {
  acceptedBatches: number;
  lastEpisodeUuid?: string;
};

/**
 * Tracks Graphiti episode continuity independently for every agent + OpenClaw session.
 * The queue is per agent, but predecessor state must be per saga/session because
 * batches from multiple dialogs can be interleaved in that queue.
 *
 * State advances only after Graphiti accepts a batch and returns its UUID.
 */
export class EpisodeSequenceTracker {
  private readonly agents = new Map<string, Map<string, SessionSequenceState>>();

  prepare(agentId: string, sessionKey: string): PreparedEpisodeSequence {
    const state = this.getState(agentId, sessionKey);
    const batchNumber = state.acceptedBatches + 1;
    const previousEpisodeUuids = state.lastEpisodeUuid ? [state.lastEpisodeUuid] : [];
    return {
      batchNumber,
      name: `${episodeNamePrefix(sessionKey)}-${batchNumber}`,
      previousEpisodeUuids,
      sagaPreviousEpisodeUuid: state.lastEpisodeUuid,
    };
  }

  accept(agentId: string, sessionKey: string, batchNumber: number, episodeUuid: string): void {
    if (!episodeUuid.trim()) throw new Error("Graphiti accepted episode UUID must be non-empty");
    const state = this.getState(agentId, sessionKey);
    const expected = state.acceptedBatches + 1;
    if (batchNumber !== expected) {
      throw new Error(`episode sequence out of order for ${agentId}/${sessionKey}: expected ${expected}, got ${batchNumber}`);
    }
    state.acceptedBatches = batchNumber;
    state.lastEpisodeUuid = episodeUuid;
  }

  snapshot(agentId: string, sessionKey: string): Readonly<SessionSequenceState> {
    const state = this.getState(agentId, sessionKey);
    return { ...state };
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
