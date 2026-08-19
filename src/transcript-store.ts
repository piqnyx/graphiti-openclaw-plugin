import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveOpenClawStateDir } from "./capture-spool.js";

/**
 * The gateway's own transcript, read where it is written.
 *
 * The agent_end hook was the only source for a long time, and it turned out to be
 * lossy in ways that cost weeks: message text is rewritten between observations,
 * identifying metadata is dropped on replay, entries are spliced into the middle
 * of history, and anything missed is missed forever because the hook never
 * repeats itself. Every attempt to reconstruct "what is new" from two consecutive
 * deliveries failed on a form of rewriting we had not met yet.
 *
 * The store has none of those properties. Rows are append-only under a per-session
 * `seq`, each carries the identity the gateway assigned it, and the file survives
 * restarts, crashes and a plugin that refused to load. Reading it turns "catch
 * every event in flight or lose it" into "read up to where you left off".
 */

/** Columns this reader depends on. A missing one means the schema moved under us. */
const REQUIRED_SCHEMA: Record<string, readonly string[]> = {
  transcript_events: ["session_id", "seq", "event_json"],
  transcript_event_identities: ["session_id", "event_id", "seq"],
  session_nodes: ["session_key", "current_session_id"],
};

/** Rows kept, and the position the scan actually reached. */
export type TranscriptRead = {
  rows: TranscriptRow[];
  /**
   * Highest seq examined, kept or discarded.
   *
   * The cursor must move to this and not to the last kept row: a session can end
   * in machinery, or in nothing but machinery, and stopping at the last
   * conversational row would re-read the tail on every turn forever.
   */
  scannedThrough: number;
};

/**
 * Rows per read.
 *
 * A first look at a long session would otherwise pull the whole thing into memory
 * at once, and inbound photos live in these rows as base64 -- a couple of hundred
 * kilobytes each. Reading in slices costs nothing: the cursor advances to what was
 * scanned, and the next turn continues from there.
 */
const MAX_ROWS_PER_READ = 500;

export type TranscriptRow = {
  seq: number;
  eventId: string;
  parentId?: string;
  /** The gateway's message object, handed to the existing sanitisation untouched. */
  message: unknown;
};

export class TranscriptSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptSchemaError";
  }
}

/**
 * Default location of an agent's store.
 *
 * Resolved through the same state directory the rest of the plugin uses, so a
 * deployment that moves ~/.openclaw moves this with it instead of leaving capture
 * reading a path nobody writes to.
 */
export function defaultAgentDbPath(agentId: string): string {
  return join(resolveOpenClawStateDir(), "agents", agentId, "agent", "openclaw-agent.sqlite");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class TranscriptStore {
  private readonly db: DatabaseSync;
  /** Internal-system verdicts are stable per event; asking twice is wasted I/O. */
  private readonly internalCache = new Map<string, boolean>();

  constructor(readonly path: string) {
    // Read-only, so a bug here can never damage the gateway's own state. The store
    // runs in WAL mode, where a reader sees a consistent snapshot without blocking
    // the gateway's writes or being blocked by them.
    this.db = new DatabaseSync(path, { readOnly: true });
  }

  /**
   * Prove the tables and columns are still the ones we read.
   *
   * Called once, at registration, and allowed to throw: refusing to load is the
   * loud failure this deserves. Nothing is lost by stopping -- the store keeps
   * accumulating, and a fixed plugin reads the backlog from its cursor. Guessing
   * against a changed schema is what would lose data.
   */
  verify(): void {
    for (const [table, columns] of Object.entries(REQUIRED_SCHEMA)) {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
      if (rows.length === 0) {
        throw new TranscriptSchemaError(
          `${this.path}: table ${table} is missing; OpenClaw's transcript schema changed`,
        );
      }
      const present = new Set(rows.map((row) => String(row.name)));
      const absent = columns.filter((column) => !present.has(column));
      if (absent.length > 0) {
        throw new TranscriptSchemaError(
          `${this.path}: ${table} lacks ${absent.join(", ")}; OpenClaw's transcript schema changed`,
        );
      }
    }
  }

  /**
   * The session currently answering to this key.
   *
   * A rewind does not edit history: it freezes the old session, copies the kept
   * prefix into a new one and repoints the key. Measured on a live rewind -- the
   * old row kept all 55 events and 54 of their ids reappeared in the new session.
   * So the id here changes under a stable key, and the caller must expect that.
   */
  currentSessionId(sessionKey: string): string | undefined {
    const row = this.db
      .prepare("SELECT current_session_id AS id FROM session_nodes WHERE session_key = ?")
      .get(sessionKey) as { id?: unknown } | undefined;
    return typeof row?.id === "string" ? row.id : undefined;
  }

  /** Highest seq stored for a session, or -1 when it has no events yet. */
  maxSeq(sessionId: string): number {
    const row = this.db
      .prepare("SELECT MAX(seq) AS seq FROM transcript_events WHERE session_id = ?")
      .get(sessionId) as { seq?: unknown } | undefined;
    return typeof row?.seq === "number" ? row.seq : -1;
  }

  /**
   * Conversation rows after `afterSeq`, oldest first.
   *
   * Everything that is not a user or assistant message is dropped here rather
   * than downstream: the store also holds tool results, thinking-level changes,
   * session markers and the gateway's own heartbeat, and none of them is
   * conversation. Assistant replies to an internal turn go too -- `HEARTBEAT_OK`
   * carries no marker of its own and is only recognisable through its parent.
   */
  readAfter(sessionId: string, afterSeq: number, limit = MAX_ROWS_PER_READ): TranscriptRead {
    const rows = this.db
      .prepare(
        "SELECT e.seq AS seq, e.event_json AS json FROM transcript_events e " +
          "WHERE e.session_id = ? AND e.seq > ? ORDER BY e.seq LIMIT ?",
      )
      .all(sessionId, afterSeq, limit) as Array<{ seq: unknown; json: unknown }>;

    const result: TranscriptRow[] = [];
    let scannedThrough = afterSeq;
    for (const row of rows) {
      if (typeof row.seq !== "number" || typeof row.json !== "string") continue;
      scannedThrough = Math.max(scannedThrough, row.seq);
      let event: unknown;
      try {
        event = JSON.parse(row.json);
      } catch {
        // One unreadable row must not stop the rest of the conversation.
        continue;
      }
      if (!isRecord(event) || event.type !== "message") continue;
      const message = event.message;
      if (!isRecord(message)) continue;
      if (message.role !== "user" && message.role !== "assistant") continue;

      const eventId = typeof event.id === "string" ? event.id : "";
      if (!eventId) continue;
      const parentId = typeof event.parentId === "string" ? event.parentId : undefined;

      if (this.isInternal(sessionId, eventId, message)) continue;
      if (parentId && this.isInternal(sessionId, parentId)) continue;

      result.push({ seq: row.seq, eventId, ...(parentId ? { parentId } : {}), message });
    }
    return { rows: result, scannedThrough };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Closing a store we are done with cannot be worth an exception.
    }
  }

  /** Beyond this the oldest verdicts are forgotten; they are cheap to ask again. */
  private static readonly MAX_CACHED_VERDICTS = 20_000;

  /** Is this event the gateway talking to itself? */
  private isInternal(sessionId: string, eventId: string, known?: Record<string, unknown>): boolean {
    const cached = this.internalCache.get(eventId);
    if (cached !== undefined) return cached;

    let message = known;
    if (!message) {
      const row = this.db
        .prepare("SELECT event_json AS json FROM transcript_events WHERE session_id = ? AND seq = " +
          "(SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?)")
        .get(sessionId, sessionId, eventId) as { json?: unknown } | undefined;
      if (typeof row?.json === "string") {
        try {
          const parsed: unknown = JSON.parse(row.json);
          if (isRecord(parsed) && isRecord(parsed.message)) message = parsed.message;
        } catch {
          message = undefined;
        }
      }
    }

    const provenance = message?.provenance;
    const internal = isRecord(provenance) && provenance.kind === "internal_system";
    if (this.internalCache.size >= TranscriptStore.MAX_CACHED_VERDICTS) {
      const oldest = this.internalCache.keys().next().value;
      if (oldest !== undefined) this.internalCache.delete(oldest);
    }
    this.internalCache.set(eventId, internal);
    return internal;
  }
}
