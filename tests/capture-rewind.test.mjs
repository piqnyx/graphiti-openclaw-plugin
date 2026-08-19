import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "../dist/index.js";
import { resetCaptureRuntimeForTests } from "../dist/capture-runtime.js";
import { resolveDurableCaptureRoot } from "../dist/capture-pipeline.js";
import { DurableCaptureJournal } from "../dist/durable-capture-journal.js";

/**
 * The rewind, driven through the real hook.
 *
 * The unit test for this rebuilt the dedup filter inside the test body, so it
 * could not fail when the pipeline stopped passing the captured ids to it -- and
 * that is exactly what happened: a rewind reset the cursor to empty and the whole
 * copied prefix was captured a second time. This one asserts on what actually
 * reaches the durable buffer.
 */

const SESSION = "agent:main:dashboard:rewind";
const ctx = { agentId: "main", sessionKey: SESSION, trigger: "user" };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "graphiti-rewind-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "agents", "main", "agent");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "openclaw-agent.sqlite"));
  db.exec("CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT)");
  db.exec("CREATE TABLE transcript_event_identities (session_id TEXT, event_id TEXT, seq INTEGER)");
  db.exec("CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT)");

  const point = (sessionId) => {
    db.prepare("DELETE FROM session_nodes WHERE session_key = ?").run(SESSION);
    db.prepare("INSERT INTO session_nodes VALUES (?, ?)").run(SESSION, sessionId);
  };
  const row = (sessionId, seq, role, text, eventId) => {
    const event = { type: "message", id: eventId, message: { role, content: text } };
    db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)").run(sessionId, seq, JSON.stringify(event));
    db.prepare("INSERT INTO transcript_event_identities VALUES (?, ?, ?)").run(sessionId, eventId, seq);
  };

  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = stateDir;
  resetCaptureRuntimeForTests();
  t.after(() => resetCaptureRuntimeForTests());

  const hooks = new Map();
  register({
    pluginConfig: {
      autoRecall: false,
      bufferLimit: 50,
      bufferTimeout: 3600,
      agentDbPath: join(root, "agents", "{agentId}", "agent", "openclaw-agent.sqlite"),
      agents: { main: { user: "Вит", assistant: "Ева" } },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on: (name, handler) => hooks.set(name, handler),
  });

  const buffered = () => {
    const journal = new DurableCaptureJournal(resolveDurableCaptureRoot());
    return (journal.read("main", SESSION)?.committed?.active?.messages ?? []).map((m) => m.text);
  };

  return { point, row, turn: () => hooks.get("agent_end")({ success: true, messages: [] }, ctx), buffered };
}

test("a rewind captures only what is new, not the prefix it copied forward", async (t) => {
  const f = fixture(t);

  f.point("sess-A");
  f.row("sess-A", 0, "user", "первое сообщение", "ev-0");
  f.row("sess-A", 1, "assistant", "первый ответ", "ev-1");
  f.turn();
  assert.deepEqual(f.buffered(), ["первое сообщение", "первый ответ"]);

  // The gateway freezes sess-A, copies the kept prefix into sess-B under the very
  // same event ids, and repoints the key. Measured on a live rewind: 54 of 55.
  f.row("sess-B", 0, "user", "первое сообщение", "ev-0");
  f.row("sess-B", 1, "assistant", "первый ответ", "ev-1");
  f.row("sess-B", 2, "user", "новое сообщение", "ev-2");
  f.point("sess-B");
  f.turn();

  assert.deepEqual(f.buffered(), ["первое сообщение", "первый ответ", "новое сообщение"]);
});

test("a rewind that drops the tail does not re-capture what survived it", async (t) => {
  const f = fixture(t);

  f.point("sess-A");
  f.row("sess-A", 0, "user", "раз", "ev-0");
  f.row("sess-A", 1, "assistant", "ответ раз", "ev-1");
  f.row("sess-A", 2, "user", "два", "ev-2");
  f.turn();
  assert.deepEqual(f.buffered(), ["раз", "ответ раз", "два"]);

  // Rewound past "два": the new session keeps only the first exchange and then
  // goes somewhere else. The dropped message stays in memory -- captured is
  // captured -- and nothing is taken twice.
  f.row("sess-B", 0, "user", "раз", "ev-0");
  f.row("sess-B", 1, "assistant", "ответ раз", "ev-1");
  f.row("sess-B", 2, "user", "другое продолжение", "ev-9");
  f.point("sess-B");
  f.turn();

  assert.deepEqual(f.buffered(), ["раз", "ответ раз", "два", "другое продолжение"]);
});
