import test from "node:test";
import assert from "node:assert/strict";
import { BufferEngine } from "../dist/buffer.js";
import { TranscriptDeltaTracker } from "../dist/transcript-delta.js";

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

test("first observation captures only current tail, including consecutive users", () => {
  const tracker = new TranscriptDeltaTracker();
  const delta = tracker.take("main", "s1", [
    u("old-u"), a("old-a"), u("u1"), u("u2"), u("u3"), a("a1"),
  ]);
  assert.deepEqual(delta, [u("u1"), u("u2"), u("u3"), a("a1")]);
});

test("successive snapshots emit only new user/assistant messages", () => {
  const tracker = new TranscriptDeltaTracker();
  assert.deepEqual(tracker.take("main", "s1", [u("u1")]), [u("u1")]);
  assert.deepEqual(tracker.take("main", "s1", [u("u1"), u("u2")]), [u("u2")]);
  assert.deepEqual(tracker.take("main", "s1", [u("u1"), u("u2"), u("u3")]), [u("u3")]);
  assert.deepEqual(
    tracker.take("main", "s1", [u("u1"), u("u2"), u("u3"), a("a1")]),
    [a("a1")],
  );
});

test("seven users plus assistant split by hard message limit without loss", async (t) => {
  const entries = [];
  const engine = new BufferEngine(agents, 6, 3600, async (_agentId, entry) => {
    entries.push(entry);
  });
  t.after(() => engine.stop());

  engine.addMessages("main", "s1", [
    u("u1"), u("u2"), u("u3"), u("u4"), u("u5"), u("u6"), u("u7"), a("a1"),
  ]);

  await waitFor(() => entries.length === 1);
  assert.deepEqual(entries[0].buffer.messages, [u("u1"), u("u2"), u("u3"), u("u4"), u("u5"), u("u6")]);
  assert.equal(engine.activeBufferCount("main"), 1);
});

test("one lonely user message is eligible for timeout flush", async (t) => {
  const originalNow = Date.now;
  const originalSetInterval = globalThis.setInterval;
  let now = 1_700_000_000_000;
  let tick;
  Date.now = () => now;
  globalThis.setInterval = (fn) => {
    tick = fn;
    return { unref() {} };
  };
  t.after(() => {
    Date.now = originalNow;
    globalThis.setInterval = originalSetInterval;
  });

  const entries = [];
  const engine = new BufferEngine(agents, 6, 30, async (_agentId, entry, reason) => {
    entries.push({ entry, reason });
  });
  t.after(() => engine.stop());

  engine.addMessage("main", "s1", "user", "lonely-user");
  now += 30_000;
  await tick();
  await waitFor(() => entries.length === 1);

  assert.equal(entries[0].reason, "timeout");
  assert.deepEqual(entries[0].entry.buffer.messages, [u("lonely-user")]);
});

test("a durable watermark resumes an aborted user-only tail without replaying it", () => {
  const before = new TranscriptDeltaTracker();
  // Run ended on a user message with no assistant reply, then the gateway stopped.
  assert.deepEqual(before.take("main", "s1", [u("old-u"), a("old-a"), u("u1")]), [u("u1")]);
  const carried = before.export();
  assert.equal(carried.length, 1);
  assert.equal(carried[0].sessionKey, "s1");

  const after = new TranscriptDeltaTracker();
  assert.equal(after.restore(carried), 1);
  assert.deepEqual(
    after.take("main", "s1", [u("old-u"), a("old-a"), u("u1"), u("u2"), a("a2")]),
    [u("u2"), a("a2")],
    "u1 was already captured before the restart and must not be captured twice",
  );
});

test("a durable watermark recovers a turn that was never observed before the restart", () => {
  const before = new TranscriptDeltaTracker();
  before.take("main", "s1", [u("u1"), a("a1")]);
  const carried = before.export();

  const after = new TranscriptDeltaTracker();
  after.restore(carried);
  assert.deepEqual(
    after.take("main", "s1", [u("u1"), a("a1"), u("u2"), a("a2")]),
    [u("u2"), a("a2")],
  );
});

test("watermarks are content free, bounded and expire", () => {
  const tracker = new TranscriptDeltaTracker();
  const long = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? u(`u${i}`) : a(`a${i}`)));
  tracker.take("main", "s1", long);

  const [watermark] = tracker.export();
  assert.equal(watermark.tailHashes.length, 12, "only a bounded tail is persisted");
  assert.equal(watermark.observedMessages, 40);
  assert.match(JSON.stringify(watermark), /^[^а-яА-Я]*$/);
  assert.ok(!JSON.stringify(watermark).includes("u38"), "message text never reaches the spool");

  const expired = new TranscriptDeltaTracker();
  assert.equal(
    expired.restore([{ ...watermark, updatedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 }]),
    0,
    "a stale watermark is dropped instead of anchoring an old transcript",
  );
});

test("a rewritten transcript with no watermark match falls back to tail detection", () => {
  const tracker = new TranscriptDeltaTracker();
  tracker.restore([
    {
      agentId: "main",
      sessionKey: "s1",
      tailHashes: ["00000000", "11111111"],
      observedMessages: 2,
      updatedAt: Date.now(),
    },
  ]);
  assert.deepEqual(
    tracker.take("main", "s1", [u("old-u"), a("old-a"), u("u1"), a("a1")]),
    [u("u1"), a("a1")],
  );
});
