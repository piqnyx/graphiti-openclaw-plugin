import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * A stand-in for the gateway's transcript store.
 *
 * Capture refuses to load when it cannot read that store, which is the intended
 * behaviour in production and means every test that builds a pipeline has to
 * provide one. Rows can be appended so a test can drive capture the way the
 * gateway would, by writing conversation rather than by calling a hook.
 */
const DEFAULT_AGENTS = ["main", "igor", "red", "orange", "second", "other", "a", "b"];

export function makeAgentStore(agentIds = DEFAULT_AGENTS) {
  const root = mkdtempSync(join(tmpdir(), "graphiti-agent-store-"));
  const dbs = new Map();
  for (const agentId of agentIds) {
    const dir = join(root, agentId, "agent");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "openclaw-agent.sqlite"));
    db.exec("CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT)");
    db.exec("CREATE TABLE transcript_event_identities (session_id TEXT, event_id TEXT, seq INTEGER)");
    db.exec("CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT)");
    dbs.set(agentId, db);
  }

  const bind = (agentId, sessionKey, sessionId) => {
    dbs.get(agentId).prepare("INSERT INTO session_nodes VALUES (?, ?)").run(sessionKey, sessionId);
  };

  const append = (agentId, sessionId, seq, role, text, eventId = `e${seq}`) => {
    const db = dbs.get(agentId);
    const event = { type: "message", id: eventId, message: { role, content: text } };
    db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)").run(sessionId, seq, JSON.stringify(event));
    db.prepare("INSERT INTO transcript_event_identities VALUES (?, ?, ?)").run(sessionId, eventId, seq);
  };

  // Tests describe a turn the way the gateway does -- by handing over the whole
  // conversation so far -- so only the tail beyond what the store already holds is
  // written. That mirrors a real turn, where earlier rows are already on disk.
  const written = new Map();
  const deliver = (agentId, sessionKey, messages) => {
    if (!dbs.has(agentId)) return;
    const sessionId = `sess-${sessionKey}`;
    const seen = written.get(`${agentId}\u0000${sessionKey}`) ?? 0;
    if (seen === 0) bind(agentId, sessionKey, sessionId);
    let seq = seen;
    for (const message of messages.slice(seen)) {
      const role = message?.role;
      const content = typeof message?.content === "string" ? message.content : message?.content ?? "";
      append(agentId, sessionId, seq, role, content, `${sessionId}-${seq}`);
      seq += 1;
    }
    written.set(`${agentId}\u0000${sessionKey}`, Math.max(seen, messages.length));
  };

  return {
    root,
    agentDbPath: join(root, "{agentId}", "agent", "openclaw-agent.sqlite"),
    bind,
    append,
    deliver,
  };
}
