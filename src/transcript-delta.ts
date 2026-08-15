import type { ConversationMessage } from "./text.js";

function sameMessage(a: ConversationMessage, b: ConversationMessage): boolean {
  return a.role === b.role && a.text === b.text;
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

export class TranscriptDeltaTracker {
  private readonly snapshots = new Map<string, ConversationMessage[]>();

  take(agentId: string, sessionKey: string, snapshot: readonly ConversationMessage[]): ConversationMessage[] {
    const key = JSON.stringify([agentId, sessionKey]);
    const current = snapshot.map((message) => ({ ...message }));
    const previous = this.snapshots.get(key);
    this.snapshots.set(key, current);

    if (!previous) return initialTail(current);
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
}
