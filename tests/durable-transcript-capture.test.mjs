import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableBufferEngine } from "../dist/durable-buffer-engine.js";
import { advanceCursor, emptyCursor } from "../dist/capture-cursor.js";

const actors = { main: { user: "Вит", assistant: "Краб" } };
const u = (text) => ({ role: "user", text });
const a = (text) => ({ role: "assistant", text });
const rows = (...pairs) => pairs.map(([seq, eventId]) => ({ seq, eventId, message: {} }));

function rootFor(t) {
  const root = mkdtempSync(join(tmpdir(), "graphiti-durable-transcript-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a restart resumes from the cursor the journal committed with the messages", async (t) => {
  const root = rootFor(t);
  const first = new DurableBufferEngine(root, actors, 20, 3600, async () => {});
  const cursor = advanceCursor(emptyCursor("sess-1"), "sess-1", rows([0, "e0"], [1, "e1"]), 1);
  first.ingest("main", "s1", [u("u1"), a("a1")], cursor);
  await first.shutdown(200);

  const second = new DurableBufferEngine(root, actors, 20, 3600, async () => {});
  t.after(() => second.shutdown(200));

  const restored = second.sessionCursor("main", "s1");
  assert.equal(restored.sessionId, "sess-1");
  assert.equal(restored.lastSeq, 1);
  assert.deepEqual(restored.capturedEventIds, ["e0", "e1"]);
  assert.deepEqual(
    second.journal.read("main", "s1").committed.active.messages.map((m) => m.text),
    ["u1", "a1"],
  );
});

test("a failed local transaction cannot advance the cursor", async (t) => {
  const root = rootFor(t);
  const engine = new DurableBufferEngine(root, actors, 20, 3600, async () => {});
  t.after(() => engine.shutdown(200));

  const first = advanceCursor(emptyCursor("sess-1"), "sess-1", rows([0, "e0"]), 0);
  engine.ingest("main", "s1", [u("u1")], first);

  const originalCommit = engine.journal.commit.bind(engine.journal);
  let failOnce = true;
  engine.journal.commit = (params) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("disk is unhappy");
    }
    return originalCommit(params);
  };

  const second = advanceCursor(first, "sess-1", rows([1, "e1"]), 1);
  assert.throws(() => engine.ingest("main", "s1", [a("a1")], second), /disk is unhappy/);

  // The cursor is what decides which rows are read next. A write that did not land
  // must leave it behind, or the unwritten messages are never looked at again.
  const stored = engine.sessionCursor("main", "s1");
  assert.equal(stored.lastSeq, 0);
  assert.deepEqual(stored.capturedEventIds, ["e0"]);
});

test("a provider outage does not stop new messages entering the disk FIFO", async (t) => {
  const root = rootFor(t);
  const engine = new DurableBufferEngine(root, actors, 2, 3600, async () => {
    throw new Error("provider down");
  });
  t.after(() => engine.shutdown(200));

  let cursor = emptyCursor("sess-1");
  for (const [seq, id, message] of [
    [0, "e0", u("u1")],
    [1, "e1", a("a1")],
    [2, "e2", u("u2")],
    [3, "e3", a("a2")],
  ]) {
    cursor = advanceCursor(cursor, "sess-1", rows([seq, id]), seq);
    engine.ingest("main", "s1", [message], cursor);
  }

  assert.ok(engine.queueDepth("main") >= 1, "batches reached the durable queue despite the outage");
  assert.equal(engine.sessionCursor("main", "s1").lastSeq, 3);
});
