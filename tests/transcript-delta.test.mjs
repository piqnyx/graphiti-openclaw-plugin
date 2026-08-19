import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableBufferEngine } from "../dist/durable-buffer-engine.js";
import {
  TranscriptCursorError,
  TranscriptDeltaTracker,
  WATERMARK_TAIL_MESSAGES,
  messageHash,
} from "../dist/transcript-delta.js";

const agents = { main: { user: "Вит", assistant: "Краб" } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail("condition was not met before timeout");
}

const u = (text) => ({ role: "user", text });
const a = (text) => ({ role: "assistant", text });

function rootFor(t) {
  const root = mkdtempSync(join(tmpdir(), "graphiti-transcript-delta-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function watermark(sessionKey, observedMessages) {
  return {
    agentId: "main",
    sessionKey,
    tailHashes: [String(observedMessages).padStart(64, "0")],
    observedMessages,
    prefixDigest: "e".repeat(64),
    updatedAt: Date.now(),
  };
}

test("first observation captures only the current tail, including consecutive users", () => {
  const tracker = new TranscriptDeltaTracker();
  const delta = tracker.take("main", "s1", [
    u("old-u"), a("old-a"), u("u1"), u("u2"), u("u3"), a("a1"),
  ]);
  assert.deepEqual(delta, [u("u1"), u("u2"), u("u3"), a("a1")]);
});

test("successive snapshots emit only new user/assistant messages", () => {
  const tracker = new TranscriptDeltaTracker();
  assert.deepEqual(tracker.take("main", "s1", [u("u1")]), [u("u1")]);
  tracker.commit("main", "s1");
  assert.deepEqual(tracker.take("main", "s1", [u("u1"), u("u2")]), [u("u2")]);
  tracker.commit("main", "s1");
  assert.deepEqual(tracker.take("main", "s1", [u("u1"), u("u2"), u("u3")]), [u("u3")]);
  tracker.commit("main", "s1");
  assert.deepEqual(
    tracker.take("main", "s1", [u("u1"), u("u2"), u("u3"), a("a1")]),
    [a("a1")],
  );
});

test("seven users plus assistant split by hard message limit without loss", async (t) => {
  const entries = [];
  const engine = new DurableBufferEngine(rootFor(t), agents, 6, 3600, async (_agentId, entry) => {
    entries.push(entry);
  });
  t.after(() => engine.shutdown(200));

  engine.ingest(
    "main",
    "s1",
    [u("u1"), u("u2"), u("u3"), u("u4"), u("u5"), u("u6"), u("u7"), a("a1")],
    watermark("s1", 8),
  );

  await waitFor(() => entries.length === 1);
  assert.deepEqual(entries[0].buffer.messages, [u("u1"), u("u2"), u("u3"), u("u4"), u("u5"), u("u6")]);
  assert.equal(engine.activeBufferCount("main"), 1);
  const state = engine.journal.read("main", "s1").committed;
  assert.deepEqual(state.active.messages, [u("u7"), a("a1")]);
});

test("one lonely user message is eligible for timeout flush", async (t) => {
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });

  const entries = [];
  const engine = new DurableBufferEngine(rootFor(t), agents, 6, 30, async (_agentId, entry, reason) => {
    entries.push({ entry, reason });
  });
  t.after(() => engine.shutdown(200));

  engine.ingest("main", "s1", [u("lonely-user")], watermark("s1", 1));
  now += 29_999;
  await engine.tick();
  assert.equal(entries.length, 0);
  now += 1;
  await engine.tick();
  await waitFor(() => entries.length === 1);

  assert.equal(entries[0].reason, "timeout");
  assert.deepEqual(entries[0].entry.buffer.messages, [u("lonely-user")]);
});

test("pending watermark is a candidate until durable capture commits it", () => {
  const tracker = new TranscriptDeltaTracker();
  tracker.take("main", "s1", [u("u1"), a("a1")]);

  const candidate = tracker.pendingWatermark("main", "s1");
  assert.equal(candidate.observedMessages, 2);
  assert.deepEqual(tracker.export(), [], "preparing a cursor must not advance durable truth");

  const committed = tracker.commit("main", "s1");
  assert.equal(committed.observedMessages, 2);
  assert.deepEqual(tracker.export(), [committed]);
});

test("rollback after a local durability failure replays the uncommitted delta", () => {
  const tracker = new TranscriptDeltaTracker();
  tracker.take("main", "s1", [u("u1"), a("a1")]);
  tracker.commit("main", "s1");

  assert.deepEqual(
    tracker.take("main", "s1", [u("u1"), a("a1"), u("u2"), a("a2")]),
    [u("u2"), a("a2")],
  );
  tracker.rollback("main", "s1");

  assert.deepEqual(
    tracker.take("main", "s1", [u("u1"), a("a1"), u("u2"), a("a2")]),
    [u("u2"), a("a2")],
    "messages whose disk transaction failed must be offered again",
  );
});

test("an ambiguous transcript failure does not poison the next cursor", () => {
  const tracker = new TranscriptDeltaTracker();
  tracker.take("main", "s1", [u("u1"), a("a1")]);
  tracker.commit("main", "s1");

  assert.throws(
    () => tracker.take("main", "s1", [u("completely rewritten")]),
    TranscriptCursorError,
  );

  assert.deepEqual(
    tracker.take("main", "s1", [u("u1"), a("a1"), u("u2")]),
    [u("u2")],
  );
});

test("a durable watermark resumes an aborted user-only tail without replaying it", () => {
  const before = new TranscriptDeltaTracker();
  assert.deepEqual(before.take("main", "s1", [u("old-u"), a("old-a"), u("u1")]), [u("u1")]);
  before.commit("main", "s1");
  const carried = before.export();

  const after = new TranscriptDeltaTracker();
  assert.equal(after.restore(carried), 1);
  assert.deepEqual(
    after.take("main", "s1", [u("old-u"), a("old-a"), u("u1"), u("u2"), a("a2")]),
    [u("u2"), a("a2")],
  );
});

test("compacted transcript resumes only from a unique durable tail", () => {
  const previous = [u("old-u"), a("old-a"), u("anchor-u"), a("anchor-a")];
  const tracker = new TranscriptDeltaTracker();
  tracker.restore([
    {
      agentId: "main",
      sessionKey: "s1",
      tailHashes: [messageHash(u("anchor-u")), messageHash(a("anchor-a"))],
      observedMessages: previous.length,
      prefixDigest: "f".repeat(64),
      updatedAt: Date.now(),
    },
  ]);

  assert.deepEqual(
    tracker.take("main", "s1", [u("anchor-u"), a("anchor-a"), u("new-u"), a("new-a")]),
    [u("new-u"), a("new-a")],
  );
});

test("durable watermarks contain no text, keep a bounded tail, and do not age out", () => {
  const tracker = new TranscriptDeltaTracker();
  const long = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? u(`u${i}`) : a(`a${i}`)));
  tracker.take("main", "s1", long);
  tracker.commit("main", "s1");

  const [mark] = tracker.export();
  assert.equal(mark.tailHashes.length, WATERMARK_TAIL_MESSAGES);
  assert.equal(mark.observedMessages, 40);
  assert.match(JSON.stringify(mark), /^[^а-яА-Я]*$/);
  assert.ok(!JSON.stringify(mark).includes("u38"));

  const yearsLater = new TranscriptDeltaTracker();
  assert.equal(
    yearsLater.restore([{ ...mark, updatedAt: Date.now() - 10 * 365 * 24 * 60 * 60 * 1000 }]),
    1,
    "durable conversation cursors must survive long-term memory retention",
  );
});

test("durable session cursors are not evicted with the in-memory snapshot cache", () => {
  const tracker = new TranscriptDeltaTracker();
  for (let i = 0; i < 300; i += 1) {
    tracker.take("main", `s${i}`, [u(`u${i}`), a(`a${i}`)]);
    tracker.commit("main", `s${i}`);
  }
  assert.equal(tracker.export().length, 300);
});
