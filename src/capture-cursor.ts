import type { TranscriptRow } from "./transcript-store.js";

/**
 * How much of a session's transcript has already been captured.
 *
 * `lastSeq` alone would be enough if sessions were immutable, but a rewind
 * repoints the session key at a fresh `sessionId` whose first rows are copies of
 * the old ones -- measured on a live rewind, 54 of 55 event ids reappeared. Read
 * from zero after such a switch and every copied message is captured twice.
 *
 * So the seq is an optimisation and the id set is the truth: a row whose event id
 * is already here has been captured, whatever session it now sits in and whatever
 * position it occupies. That makes reading idempotent, which in turn makes it
 * safe to re-read after a crash, a schema mismatch, or a week of downtime.
 */
export type SessionCursor = {
  sessionId: string;
  lastSeq: number;
  capturedEventIds: string[];
};

/**
 * Ids kept per session before the oldest are forgotten.
 *
 * Only protects against re-capturing what a rewind copied forward, so it needs to
 * cover the deepest rewind anyone would perform, not the whole conversation. Ten
 * thousand ids is roughly a megabyte and far beyond any plausible rewind.
 */
export const MAX_REMEMBERED_EVENT_IDS = 10_000;

export function emptyCursor(sessionId: string): SessionCursor {
  return { sessionId, lastSeq: -1, capturedEventIds: [] };
}

/**
 * Follow the session key to a new session without forgetting what was captured.
 *
 * A rewind is the only thing that does this, and it is precisely the moment the
 * id set earns its keep: the new session opens with copies of the old rows, under
 * their original ids. Carrying the ids and restarting the row count is therefore
 * the whole trick -- read the copied prefix again, recognise it, keep only what is
 * new. Starting from an empty cursor instead captures the entire prefix twice.
 */
export function rebaseCursor(previous: SessionCursor, sessionId: string): SessionCursor {
  if (previous.sessionId === sessionId) return previous;
  return { sessionId, lastSeq: -1, capturedEventIds: [...previous.capturedEventIds] };
}

/**
 * Move the cursor over rows that have now been made durable.
 *
 * The seq comes from the rows themselves rather than from the caller's read
 * position: a row that was filtered out as internal must still be passed, because
 * skipping it silently would make the next read start before it and re-examine
 * ground already covered.
 */
export function advanceCursor(
  cursor: SessionCursor,
  sessionId: string,
  rows: readonly TranscriptRow[],
  observedSeq: number,
): SessionCursor {
  // Ids carry across a session change on purpose: that is what a rewind copies.
  const ids = [...cursor.capturedEventIds];
  const known = new Set(ids);
  for (const row of rows) {
    if (known.has(row.eventId)) continue;
    known.add(row.eventId);
    ids.push(row.eventId);
  }
  const overflow = ids.length - MAX_REMEMBERED_EVENT_IDS;
  return {
    sessionId,
    lastSeq: Math.max(cursor.sessionId === sessionId ? cursor.lastSeq : -1, observedSeq),
    capturedEventIds: overflow > 0 ? ids.slice(overflow) : ids,
  };
}

/** Restore a cursor from durable state, rejecting anything that is not one. */
export function parseCursor(raw: unknown): SessionCursor | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.sessionId !== "string" || !candidate.sessionId) return undefined;
  if (typeof candidate.lastSeq !== "number" || !Number.isInteger(candidate.lastSeq)) return undefined;
  const ids = candidate.capturedEventIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return undefined;
  return {
    sessionId: candidate.sessionId,
    lastSeq: candidate.lastSeq,
    capturedEventIds: [...(ids as string[])],
  };
}
