import type { ConversationMessage } from "./text.js";

/** Messages kept in a durable session watermark. */
export const WATERMARK_TAIL_MESSAGES = 12;
/** Most recent sessions kept in the durable watermark set. */
export const WATERMARK_MAX_SESSIONS = 64;
/** Most recent sessions whose full transcript is held in memory for delta computation. */
export const MAX_TRACKED_SESSIONS = 64;
/** Watermarks older than this are dropped; an older session falls back to tail detection. */
export const WATERMARK_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export type SessionWatermark = {
  agentId: string;
  sessionKey: string;
  /** Hashes of the last observed messages; content itself never reaches the spool. */
  tailHashes: string[];
  observedMessages: number;
  updatedAt: number;
};

function sameMessage(a: ConversationMessage, b: ConversationMessage): boolean {
  return a.role === b.role && a.text === b.text;
}

/** Stable FNV-1a over role+text so a watermark written before a restart still matches after it. */
export function messageHash(message: ConversationMessage): string {
  const text = `${message.role}|${message.text}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function initialTail(snapshot: readonly ConversationMessage[]): ConversationMessage[] {
  if (snapshot.length === 0) return [];

  // On first sight of a session (including after a gateway/plugin restart), do
  // not replay the whole historical transcript. Capture only the current run's
  // conversational tail: everything after the previous assistant boundary.
  const lastIndex = snapshot.length - 1;
  const last = snapshot[lastIndex]!;
  let boundary = -1;

  if (last.role === "assistant") {
    for (let i = lastIndex - 1; i >= 0; i -= 1) {
      if (snapshot[i]?.role === "assistant") {
        boundary = i;
        break;
      }
    }
  } else {
    for (let i = lastIndex; i >= 0; i -= 1) {
      if (snapshot[i]?.role === "assistant") {
        boundary = i;
        break;
      }
    }
  }

  return snapshot.slice(boundary + 1).map((message) => ({ ...message }));
}

/**
 * Find where the durable watermark ends inside the current transcript.
 *
 * The longest stored suffix is tried first so a repeated short message cannot
 * anchor the delta too early. Compaction that dropped part of the stored tail
 * still matches through the shorter suffixes. Returns -1 when nothing matches.
 */
function findWatermarkEnd(hashes: readonly string[], tailHashes: readonly string[]): number {
  for (let length = Math.min(tailHashes.length, hashes.length); length > 0; length -= 1) {
    const wanted = tailHashes.slice(tailHashes.length - length);
    for (let start = hashes.length - length; start >= 0; start -= 1) {
      let matches = true;
      for (let i = 0; i < length; i += 1) {
        if (hashes[start + i] !== wanted[i]) {
          matches = false;
          break;
        }
      }
      if (matches) return start + length - 1;
    }
  }
  return -1;
}

function longestSuffixPrefixOverlap(
  previous: readonly ConversationMessage[],
  current: readonly ConversationMessage[],
): number {
  const max = Math.min(previous.length, current.length);
  for (let size = max; size > 0; size -= 1) {
    let matches = true;
    for (let i = 0; i < size; i += 1) {
      if (!sameMessage(previous[previous.length - size + i]!, current[i]!)) {
        matches = false;
        break;
      }
    }
    if (matches) return size;
  }
  return 0;
}

function commonPrefixLength(
  previous: readonly ConversationMessage[],
  current: readonly ConversationMessage[],
): number {
  const max = Math.min(previous.length, current.length);
  let i = 0;
  while (i < max && sameMessage(previous[i]!, current[i]!)) i += 1;
  return i;
}

type PendingObservation = {
  agentId: string;
  sessionKey: string;
  messages: ConversationMessage[];
};

export class TranscriptDeltaTracker {
  private readonly snapshots = new Map<string, ConversationMessage[]>();
  private readonly watermarks = new Map<string, SessionWatermark>();
  private readonly pendingObservations = new Map<string, PendingObservation>();

  take(agentId: string, sessionKey: string, snapshot: readonly ConversationMessage[]): ConversationMessage[] {
    const key = JSON.stringify([agentId, sessionKey]);
    const current = snapshot.map((message) => ({ ...message }));
    const previous = this.snapshots.get(key);

    // Re-insert so Map iteration order stays least-recently-used first.
    this.snapshots.delete(key);
    this.snapshots.set(key, current);
    this.pendingObservations.set(key, { agentId, sessionKey, messages: current });
    this.pruneSessions();

    return this.computeDelta(key, previous, current);
  }

  /**
   * Advance the durable watermark for a session.
   *
   * Called only once the delta returned by take() is safely buffered. Observing
   * a message is not the same as capturing it: if buffering failed, the
   * watermark must stay behind so the next process re-observes those messages
   * instead of treating them as already captured.
   */
  commit(agentId: string, sessionKey: string): void {
    const key = JSON.stringify([agentId, sessionKey]);
    const observation = this.pendingObservations.get(key);
    if (!observation || observation.messages.length === 0) return;

    this.watermarks.delete(key);
    this.watermarks.set(key, {
      agentId,
      sessionKey,
      tailHashes: observation.messages.slice(-WATERMARK_TAIL_MESSAGES).map(messageHash),
      observedMessages: observation.messages.length,
      updatedAt: Date.now(),
    });
    this.pendingObservations.delete(key);
  }

  private computeDelta(
    key: string,
    previous: ConversationMessage[] | undefined,
    current: ConversationMessage[],
  ): ConversationMessage[] {
    if (!previous) return this.firstObservation(key, current);
    if (current.length === 0) return [];

    const prefix = commonPrefixLength(previous, current);
    if (prefix === previous.length) {
      return current.slice(prefix).map((message) => ({ ...message }));
    }

    // Compaction/rewrite may remove or replace an older prefix. Preserve any
    // overlapping tail and only emit what follows it.
    const overlap = longestSuffixPrefixOverlap(previous, current);
    if (overlap > 0) {
      return current.slice(overlap).map((message) => ({ ...message }));
    }

    // No trustworthy overlap: fail conservatively by treating this like the
    // first observation rather than replaying the entire historical transcript.
    return initialTail(current);
  }

  /**
   * First observation inside this process. A durable watermark from before a
   * restart tells us exactly how far the transcript was already observed, so the
   * session resumes without replaying or skipping its own tail. Without one we
   * fall back to boundary detection.
   */
  private firstObservation(key: string, current: ConversationMessage[]): ConversationMessage[] {
    const watermark = this.watermarks.get(key);
    if (!watermark || watermark.tailHashes.length === 0 || current.length === 0) {
      return initialTail(current);
    }

    const end = findWatermarkEnd(current.map(messageHash), watermark.tailHashes);
    if (end < 0) return initialTail(current);
    return current.slice(end + 1).map((message) => ({ ...message }));
  }

  /**
   * Full transcripts are held per session to compute deltas. Without a bound a
   * long-lived gateway would keep every transcript it has ever seen, so the
   * least recently used sessions are dropped; they fall back to the durable
   * watermark, or to boundary detection, on their next observation.
   */
  private pruneSessions(): void {
    while (this.snapshots.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) return;
      this.snapshots.delete(oldest);
      this.pendingObservations.delete(oldest);
    }
    while (this.watermarks.size > WATERMARK_MAX_SESSIONS) {
      const oldest = this.watermarks.keys().next().value;
      if (oldest === undefined) return;
      this.watermarks.delete(oldest);
    }
  }

  /** Bounded, content-free watermark set for the durable spool. */
  export(now = Date.now()): SessionWatermark[] {
    return [...this.watermarks.values()]
      .filter((watermark) => now - watermark.updatedAt <= WATERMARK_MAX_AGE_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, WATERMARK_MAX_SESSIONS);
  }

  restore(watermarks: readonly SessionWatermark[], now = Date.now()): number {
    let restored = 0;
    for (const watermark of watermarks) {
      if (now - watermark.updatedAt > WATERMARK_MAX_AGE_MS) continue;
      if (watermark.tailHashes.length === 0) continue;
      this.watermarks.set(JSON.stringify([watermark.agentId, watermark.sessionKey]), {
        ...watermark,
        tailHashes: [...watermark.tailHashes],
      });
      restored += 1;
    }
    return restored;
  }
}
