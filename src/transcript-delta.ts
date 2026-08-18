import { createHash } from "node:crypto";
import type { ConversationMessage } from "./text.js";

/** Messages kept as a secondary compaction anchor. */
export const WATERMARK_TAIL_MESSAGES = 32;
/** Full transcripts are only an in-memory optimization; durable cursors are never evicted. */
export const MAX_TRACKED_SESSIONS = 256;

export type SessionWatermark = {
  agentId: string;
  sessionKey: string;
  /** SHA-256 hashes of the last observed messages, used only after transcript compaction/rewrite. */
  tailHashes: string[];
  /** Number of messages in the exact transcript prefix committed with this cursor. */
  observedMessages: number;
  /** SHA-256 of that exact prefix, including role/text boundaries. */
  prefixDigest: string;
  updatedAt: number;
};

export class TranscriptCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptCursorError";
  }
}

function sameMessage(a: ConversationMessage, b: ConversationMessage): boolean {
  return a.role === b.role && a.text === b.text;
}

function feedMessage(hash: ReturnType<typeof createHash>, message: ConversationMessage): void {
  const role = Buffer.from(message.role, "utf8");
  const text = Buffer.from(message.text, "utf8");
  const lengths = Buffer.allocUnsafe(8);
  lengths.writeUInt32BE(role.length, 0);
  lengths.writeUInt32BE(text.length, 4);
  hash.update(lengths);
  hash.update(role);
  hash.update(text);
}

/** Cryptographic message identity. Hash collision must not become transcript movement. */
export function messageHash(message: ConversationMessage): string {
  const hash = createHash("sha256");
  feedMessage(hash, message);
  return hash.digest("hex");
}

/** Identity of one exact observed transcript prefix. */
export function transcriptDigest(messages: readonly ConversationMessage[]): string {
  const hash = createHash("sha256");
  const count = Buffer.allocUnsafe(8);
  count.writeBigUInt64BE(BigInt(messages.length));
  hash.update(count);
  for (const message of messages) feedMessage(hash, message);
  return hash.digest("hex");
}

function initialTail(snapshot: readonly ConversationMessage[]): ConversationMessage[] {
  if (snapshot.length === 0) return [];

  // A genuinely new/untracked session intentionally begins at the current turn,
  // not at the beginning of an arbitrarily long pre-existing transcript.
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

function tailMatchesAt(
  hashes: readonly string[],
  tailHashes: readonly string[],
  start: number,
): boolean {
  if (start < 0 || start + tailHashes.length > hashes.length) return false;
  for (let i = 0; i < tailHashes.length; i += 1) {
    if (hashes[start + i] !== tailHashes[i]) return false;
  }
  return true;
}

/**
 * Locate a compaction anchor only when it is unique.
 *
 * Picking the first/last occurrence of repeated dialogue is exactly how a cursor
 * silently jumps backwards or forwards. Ambiguity is therefore an error, not a
 * heuristic. The durable queue keeps everything already captured while the
 * operator fixes the source transcript instead of Graphiti receiving a guess.
 */
function findUniqueTailEnd(hashes: readonly string[], tailHashes: readonly string[]): number {
  if (tailHashes.length === 0 || hashes.length < tailHashes.length) return -1;
  const matches: number[] = [];
  for (let start = 0; start <= hashes.length - tailHashes.length; start += 1) {
    if (tailMatchesAt(hashes, tailHashes, start)) matches.push(start + tailHashes.length - 1);
  }
  if (matches.length === 0) return -1;
  if (matches.length > 1) {
    throw new TranscriptCursorError(
      `durable transcript tail occurs ${matches.length} times; refusing an ambiguous capture cursor`,
    );
  }
  return matches[0]!;
}

function longestSuffixPrefixOverlap(
  previous: readonly ConversationMessage[],
  current: readonly ConversationMessage[],
): number {
  const max = Math.min(previous.length, current.length);
  let best = 0;
  let bestCount = 0;
  for (let size = 1; size <= max; size += 1) {
    let matches = true;
    for (let i = 0; i < size; i += 1) {
      if (!sameMessage(previous[previous.length - size + i]!, current[i]!)) {
        matches = false;
        break;
      }
    }
    if (matches) {
      if (size > best) {
        best = size;
        bestCount = 1;
      } else if (size === best) {
        bestCount += 1;
      }
    }
  }
  return bestCount === 1 ? best : 0;
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

    this.snapshots.delete(key);
    this.snapshots.set(key, current);
    this.pendingObservations.set(key, { agentId, sessionKey, messages: current });
    this.pruneSnapshots();

    return this.computeDelta(key, previous, current);
  }

  /** Advance the durable cursor only after the returned delta is durably buffered. */
  commit(agentId: string, sessionKey: string): void {
    const key = JSON.stringify([agentId, sessionKey]);
    const observation = this.pendingObservations.get(key);
    if (!observation) return;

    this.watermarks.set(key, {
      agentId,
      sessionKey,
      tailHashes: observation.messages.slice(-WATERMARK_TAIL_MESSAGES).map(messageHash),
      observedMessages: observation.messages.length,
      prefixDigest: transcriptDigest(observation.messages),
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

    const overlap = longestSuffixPrefixOverlap(previous, current);
    if (overlap > 0) {
      return current.slice(overlap).map((message) => ({ ...message }));
    }

    throw new TranscriptCursorError(
      "OpenClaw transcript changed with no trustworthy overlap; refusing to guess which messages are new",
    );
  }

  private firstObservation(key: string, current: ConversationMessage[]): ConversationMessage[] {
    const watermark = this.watermarks.get(key);
    if (!watermark) return initialTail(current);
    if (current.length === 0) return [];

    // Normal restart path: prove that the first N messages are byte-for-byte the
    // prefix committed before shutdown. This is exact and does not depend on a
    // repeated tail phrase happening to be unique.
    if (current.length >= watermark.observedMessages) {
      const prefix = current.slice(0, watermark.observedMessages);
      if (transcriptDigest(prefix) === watermark.prefixDigest) {
        return current.slice(watermark.observedMessages).map((message) => ({ ...message }));
      }
    }

    // OpenClaw may compact old transcript history. Only then use the secondary
    // tail anchor, and only if the whole stored tail occurs exactly once.
    const end = findUniqueTailEnd(current.map(messageHash), watermark.tailHashes);
    if (end >= 0) return current.slice(end + 1).map((message) => ({ ...message }));

    throw new TranscriptCursorError(
      "durable transcript cursor is not present in the current OpenClaw transcript; refusing to skip or replay messages",
    );
  }

  private pruneSnapshots(): void {
    while (this.snapshots.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) return;
      this.snapshots.delete(oldest);
      this.pendingObservations.delete(oldest);
    }
  }

  /** Durable cursors are tiny integrity metadata and are intentionally never aged out. */
  export(): SessionWatermark[] {
    return [...this.watermarks.values()]
      .map((watermark) => ({ ...watermark, tailHashes: [...watermark.tailHashes] }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.sessionKey.localeCompare(b.sessionKey));
  }

  restore(watermarks: readonly SessionWatermark[]): number {
    let restored = 0;
    for (const watermark of watermarks) {
      if (!Number.isInteger(watermark.observedMessages) || watermark.observedMessages < 0) continue;
      if (!/^[0-9a-f]{64}$/i.test(watermark.prefixDigest)) continue;
      if (!watermark.tailHashes.every((hash) => /^[0-9a-f]{64}$/i.test(hash))) continue;
      this.watermarks.set(JSON.stringify([watermark.agentId, watermark.sessionKey]), {
        ...watermark,
        tailHashes: [...watermark.tailHashes],
      });
      restored += 1;
    }
    return restored;
  }
}
