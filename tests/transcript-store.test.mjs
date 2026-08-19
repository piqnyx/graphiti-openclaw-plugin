import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TranscriptStore, TranscriptSchemaError } from "../dist/transcript-store.js";

function makeDb(t, { omitColumn = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "graphiti-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "openclaw-agent.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT${omitColumn ? "" : ""})`);
  if (omitColumn) db.exec("DROP TABLE transcript_events; CREATE TABLE transcript_events (session_id TEXT, seq INTEGER)");
  db.exec("CREATE TABLE transcript_event_identities (session_id TEXT, event_id TEXT, seq INTEGER)");
  db.exec("CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT)");
  return { path, db };
}

function addEvent(db, sessionId, seq, event) {
  db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)").run(sessionId, seq, JSON.stringify(event));
  if (event.id) {
    db.prepare("INSERT INTO transcript_event_identities VALUES (?, ?, ?)").run(sessionId, event.id, seq);
  }
}

const say = (id, role, text, extra = {}) => ({
  type: "message",
  id,
  ...extra,
  message: { role, content: text },
});

test("a schema without the columns we read refuses to open", (t) => {
  const { path } = makeDb(t, { omitColumn: true });
  assert.throws(() => new TranscriptStore(path).verify(), TranscriptSchemaError);
});

test("a store that cannot be opened fails loudly rather than reading nothing", () => {
  // Absence is handled a level up, where an agent that has not spoken yet is
  // ordinary; anything that gets this far and still will not open is a real fault.
  assert.throws(() => new TranscriptStore(join(tmpdir(), "graphiti-no-such-dir", "agent.sqlite")));
});

test("only user and assistant messages are conversation", (t) => {
  const { path, db } = makeDb(t);
  db.prepare("INSERT INTO session_nodes VALUES (?, ?)").run("agent:main:telegram:direct:1", "sess-1");
  addEvent(db, "sess-1", 0, say("e0", "user", "привет"));
  addEvent(db, "sess-1", 1, { type: "thinking_level_change", id: "e1" });
  addEvent(db, "sess-1", 2, say("e2", "toolResult", "NOT_FOUND"));
  addEvent(db, "sess-1", 3, say("e3", "assistant", "здравствуй"));

  const store = new TranscriptStore(path);
  store.verify();
  assert.equal(store.currentSessionId("agent:main:telegram:direct:1"), "sess-1");
  assert.deepEqual(
    store.readAfter("sess-1", -1).rows.map((row) => [row.seq, row.eventId]),
    [[0, "e0"], [3, "e3"]],
  );
});

test("the gateway talking to itself is dropped, and so is the reply to it", (t) => {
  const { path, db } = makeDb(t);
  addEvent(db, "s", 0, say("h0", "user", "[OpenClaw heartbeat poll]", {}));
  db.prepare("UPDATE transcript_events SET event_json = ? WHERE seq = 0").run(
    JSON.stringify({
      type: "message",
      id: "h0",
      message: { role: "user", content: "[OpenClaw heartbeat poll]", provenance: { kind: "internal_system" } },
    }),
  );
  addEvent(db, "s", 1, { ...say("h1", "assistant", "HEARTBEAT_OK"), parentId: "h0" });
  addEvent(db, "s", 2, say("r0", "user", "настоящее сообщение"));

  const store = new TranscriptStore(path);
  // HEARTBEAT_OK carries no marker of its own; only its parent gives it away.
  assert.deepEqual(store.readAfter("s", -1).rows.map((row) => row.eventId), ["r0"]);
});

test("reading resumes strictly after the given seq", (t) => {
  const { path, db } = makeDb(t);
  for (let seq = 0; seq < 5; seq += 1) addEvent(db, "s", seq, say(`e${seq}`, "user", `m${seq}`));
  const store = new TranscriptStore(path);
  assert.deepEqual(store.readAfter("s", 2).rows.map((row) => row.seq), [3, 4]);
  assert.equal(store.maxSeq("s"), 4);
  assert.deepEqual(store.readAfter("s", 4).rows, []);
  // Nothing kept, but the scan still reports where it looked.
  assert.equal(store.readAfter("s", 2).scannedThrough, 4);
});

test("one unreadable row does not cost the rest of the conversation", (t) => {
  const { path, db } = makeDb(t);
  addEvent(db, "s", 0, say("e0", "user", "первое"));
  db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)").run("s", 1, "{ это не json");
  addEvent(db, "s", 2, say("e2", "user", "второе"));
  const store = new TranscriptStore(path);
  assert.deepEqual(store.readAfter("s", -1).rows.map((row) => row.eventId), ["e0", "e2"]);
});

test("a long session is read in slices that continue where the last one stopped", (t) => {
  const { path, db } = makeDb(t);
  for (let seq = 0; seq < 7; seq += 1) addEvent(db, "s", seq, say(`e${seq}`, "user", `m${seq}`));
  const store = new TranscriptStore(path);

  // Rows hold inbound photos as base64, so an unbounded first read of an old
  // session would pull all of it into memory at once.
  const first = store.readAfter("s", -1, 3);
  assert.deepEqual(first.rows.map((row) => row.seq), [0, 1, 2]);
  assert.equal(first.scannedThrough, 2);

  const second = store.readAfter("s", first.scannedThrough, 3);
  assert.deepEqual(second.rows.map((row) => row.seq), [3, 4, 5]);
  assert.equal(second.scannedThrough, 5);
});
