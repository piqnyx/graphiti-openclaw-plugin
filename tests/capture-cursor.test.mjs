import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceCursor,
  alreadyCaptured,
  emptyCursor,
  parseCursor,
  MAX_REMEMBERED_EVENT_IDS,
} from "../dist/capture-cursor.js";

const row = (seq, eventId) => ({ seq, eventId, message: {} });

test("a rewind re-reads the copied prefix without capturing it twice", () => {
  // Measured on a live rewind: the old session kept all its rows and 54 of their
  // ids reappeared under a new session id bound to the same session key.
  const before = advanceCursor(emptyCursor("old"), "old", [row(0, "e0"), row(1, "e1")], 1);

  const copied = [row(0, "e0"), row(1, "e1"), row(2, "e2")];
  const fresh = copied.filter((candidate) => !alreadyCaptured(before, candidate));
  assert.deepEqual(fresh.map((r) => r.eventId), ["e2"]);

  const after = advanceCursor(before, "new", copied, 2);
  assert.equal(after.sessionId, "new");
  assert.equal(after.lastSeq, 2);
  assert.deepEqual(after.capturedEventIds, ["e0", "e1", "e2"]);
});

test("a new session does not inherit the old seq", () => {
  const before = advanceCursor(emptyCursor("old"), "old", [row(40, "e40")], 40);
  const after = advanceCursor(before, "new", [row(0, "n0")], 0);
  // Reading "after seq 40" in a session that starts at zero would skip everything.
  assert.equal(after.lastSeq, 0);
});

test("rows filtered out still move the cursor past them", () => {
  // Internal rows are dropped from the delta but not from the read position;
  // leaving the cursor behind would re-examine them on every single turn.
  const cursor = advanceCursor(emptyCursor("s"), "s", [], 7);
  assert.equal(cursor.lastSeq, 7);
});

test("the remembered set is bounded and forgets the oldest first", () => {
  let cursor = emptyCursor("s");
  const many = Array.from({ length: MAX_REMEMBERED_EVENT_IDS + 10 }, (_, i) => row(i, `e${i}`));
  cursor = advanceCursor(cursor, "s", many, many.length - 1);
  assert.equal(cursor.capturedEventIds.length, MAX_REMEMBERED_EVENT_IDS);
  assert.equal(cursor.capturedEventIds[0], "e10");
  assert.equal(cursor.capturedEventIds.at(-1), `e${MAX_REMEMBERED_EVENT_IDS + 9}`);
});

test("durable state that is not a cursor is refused rather than half-read", () => {
  assert.equal(parseCursor(undefined), undefined);
  assert.equal(parseCursor({ sessionId: "s", lastSeq: 1.5, capturedEventIds: [] }), undefined);
  assert.equal(parseCursor({ sessionId: "", lastSeq: 1, capturedEventIds: [] }), undefined);
  assert.equal(parseCursor({ sessionId: "s", lastSeq: 1, capturedEventIds: [7] }), undefined);
  assert.deepEqual(parseCursor({ sessionId: "s", lastSeq: 1, capturedEventIds: ["a"] }), {
    sessionId: "s",
    lastSeq: 1,
    capturedEventIds: ["a"],
  });
});

test("a session that is entirely machinery still moves the cursor", () => {
  // The heartbeat session holds only an internal poll and the reply to it, both
  // discarded before they reach here. Leaving the cursor at -1 would re-read and
  // re-discard the whole session on every tick for as long as the agent lives.
  const cursor = advanceCursor(emptyCursor("s"), "s", [], 41);
  assert.equal(cursor.lastSeq, 41);
  assert.deepEqual(cursor.capturedEventIds, []);
});
