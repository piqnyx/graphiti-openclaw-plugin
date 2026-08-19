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
  /** Shape of the divergence, for operator logs. Never carries message text. */
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "TranscriptCursorError";
    this.details = details;
  }
}

/**
 * The bytes that identify a message across observations.
 *
 * Not its text. OpenClaw rewrites message text between turns -- a voice turn's
 * `[Audio transcript ...]` marker moves out of first position once the message is
 * stored, and assistant replies lose their blank lines in the rendered copy -- so
 * a text hash reports movement that never happened and capture stalls.
 *
 * The gateway assigns `timestamp` at creation and does not rewrite it, which makes
 * it the one field that answers "is this the same message". Text remains the
 * fallback for any channel that somehow omits it: worse, but never worse than
 * before this existed.
 */
function identityOf(message: ConversationMessage): string {
  return message.timestamp === undefined ? `t:${message.text}` : `@${message.timestamp}`;
}

function sameMessage(a: ConversationMessage, b: ConversationMessage): boolean {
  return a.role === b.role && identityOf(a) === identityOf(b);
}

function feedMessage(hash: ReturnType<typeof createHash>, message: ConversationMessage): void {
  const role = Buffer.from(message.role, "utf8");
  const identity = Buffer.from(identityOf(message), "utf8");
  const lengths = Buffer.allocUnsafe(8);
  lengths.writeUInt32BE(role.length, 0);
  lengths.writeUInt32BE(identity.length, 4);
  hash.update(lengths);
  hash.update(role);
  hash.update(identity);
}

/** Cryptographic message identity. A hash collision must not become transcript movement. */
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

/** Short enough to read in a log line, long enough to compare by eye. */
const HASH_PREVIEW_CHARS = 16;

function edgeHashes(
  messages: readonly ConversationMessage[],
): { first?: string; last?: string } {
  if (messages.length === 0) return {};
  return {
    first: messageHash(messages[0]!).slice(0, HASH_PREVIEW_CHARS),
    last: messageHash(messages[messages.length - 1]!).slice(0, HASH_PREVIEW_CHARS),
  };
}

/**
 * Describe why two snapshots would not reconcile.
 *
 * Refusing to guess is correct, but the log carried no way to tell whether the
 * gateway rewrote a message or our own sanitisation produced a different result
 * for stored history than for the live turn. Hashes only: the transcript itself
 * does not belong in the operational log.
 */
function describeDivergence(
  previous: readonly ConversationMessage[],
  current: readonly ConversationMessage[],
  commonPrefix: number,
  overlap: number,
): Record<string, unknown> {
  const before = edgeHashes(previous);
  const after = edgeHashes(current);
  return {
    previousMessages: previous.length,
    currentMessages: current.length,
    commonPrefix,
    overlap,
    previousFirstHash: before.first,
    previousLastHash: before.last,
    currentFirstHash: after.first,
    currentLastHash: after.last,
  };
}

type PendingObservation = {
  agentId: string;
  sessionKey: string;
  messages: ConversationMessage[];
};

function watermarkFor(observation: PendingObservation): SessionWatermark {
  return {
    agentId: observation.agentId,
    sessionKey: observation.sessionKey,
    tailHashes: observation.messages.slice(-WATERMARK_TAIL_MESSAGES).map(messageHash),
    observedMessages: observation.messages.length,
    prefixDigest: transcriptDigest(observation.messages),
    updatedAt: Date.now(),
  };
}

export class TranscriptDeltaTracker {
  private readonly snapshots = new Map<string, ConversationMessage[]>();
  private readonly watermarks = new Map<string, SessionWatermark>();
  private readonly pendingObservations = new Map<string, PendingObservation>();
  private readonly watermarkRecoveries = new Map<string, Record<string, unknown>>();

  take(agentId: string, sessionKey: string, snapshot: readonly ConversationMessage[]): ConversationMessage[] {
    const key = JSON.stringify([agentId, sessionKey]);
    const current = snapshot.map((message) => ({ ...message }));
    const previous = this.snapshots.get(key);

    // Compute before publishing any new in-memory cursor state. If the transcript
    // cannot be reconciled, a failed observation must not become tomorrow's trusted
    // predecessor and silently skip the very messages we refused to guess about.
    const delta = this.computeDelta(key, previous, current);

    this.snapshots.delete(key);
    this.snapshots.set(key, current);
    this.pendingObservations.set(key, { agentId, sessionKey, messages: current });
    this.pruneSnapshots();
    return delta;
  }

  /** Consume the record of the last resume that had to drop transcript history. */
  takeWatermarkRecovery(agentId: string, sessionKey: string): Record<string, unknown> | undefined {
    const key = JSON.stringify([agentId, sessionKey]);
    const recovery = this.watermarkRecoveries.get(key);
    if (recovery) this.watermarkRecoveries.delete(key);
    return recovery;
  }

  /** Build the candidate cursor without advancing the committed in-memory watermark. */
  pendingWatermark(agentId: string, sessionKey: string): SessionWatermark {
    const key = JSON.stringify([agentId, sessionKey]);
    const observation = this.pendingObservations.get(key);
    if (!observation) {
      throw new TranscriptCursorError(
        `no pending transcript observation for ${agentId}/${sessionKey}`,
      );
    }
    return watermarkFor(observation);
  }

  /** Advance the in-memory cursor only after the caller made that candidate durable. */
  commit(agentId: string, sessionKey: string): SessionWatermark | undefined {
    const key = JSON.stringify([agentId, sessionKey]);
    const observation = this.pendingObservations.get(key);
    if (!observation) return undefined;

    const watermark = watermarkFor(observation);
    this.watermarks.set(key, watermark);
    this.pendingObservations.delete(key);
    return { ...watermark, tailHashes: [...watermark.tailHashes] };
  }

  /**
   * Forget an observation whose durable transaction failed.
   *
   * The next call deliberately falls back to the last committed watermark rather
   * than the unpersisted snapshot. That turns disk-full/crash uncertainty into a
   * safe replay of the uncommitted delta instead of message loss.
   */
  rollback(agentId: string, sessionKey: string): void {
    const key = JSON.stringify([agentId, sessionKey]);
    this.snapshots.delete(key);
    this.pendingObservations.delete(key);
    // The recovery describes an observation that is being discarded; reporting it
    // later, against a different observation, would be a lie.
    this.watermarkRecoveries.delete(key);
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
      describeDivergence(previous, current, prefix, overlap),
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

    /*
     * OpenClaw may restart with a rewritten transcript where neither the exact
     * committed prefix nor the tail anchor survives. Do not block capture
     * forever. Start from the current logical turn instead.
     *
     * This intentionally prefers possible replay over permanent capture loss --
     * so it is recorded rather than taken silently. Everything before the resumed
     * turn is dropped, and until now nothing said so.
     */
    const tail = initialTail(current);
    this.watermarkRecoveries.set(key, {
      reason: "prefix_digest_and_tail_anchor_missing",
      watermarkMessages: watermark.observedMessages,
      currentMessages: current.length,
      resumedMessages: tail.length,
      droppedBeforeResume: Math.max(0, current.length - tail.length),
    });
    return tail;
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
