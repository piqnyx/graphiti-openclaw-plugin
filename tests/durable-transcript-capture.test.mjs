import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableBufferEngine } from "../dist/durable-buffer-engine.js";

const actors = { main: { user: "Вит", assistant: "Краб" } };
const u = (text) => ({ role: "user", text });
const a = (text) => ({ role: "assistant", text });

function rootFor(t) {
  const root = mkdtempSync(join(tmpdir(), "graphiti-durable-transcript-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not met before timeout");
}

test("restart reads the cursor from the same journal that owns the buffered messages", async (t) => {
  const root = rootFor(t);
  const first = new DurableBufferEngine(root, actors, 20, 3600, async () => {});

  assert.deepEqual(
    first.ingestTranscript("main", "s1", [u("old"), a("old-a"), u("u1"), a("a1")]),
    [u("u1"), a("a1")],
  );
  await first.shutdown(200);

  const second = new DurableBufferEngine(root, actors, 20, 3600, async () => {});
  t.after(() => second.shutdown(200));
  assert.deepEqual(
    second.ingestTranscript(
      "main",
      "s1",
      [u("old"), a("old-a"), u("u1"), a("a1"), u("u2"), a("a2")],
    ),
    [u("u2"), a("a2")],
  );

  const state = second.journal.read("main", "s1").committed;
  assert.equal(state.watermark.observedMessages, 6);
  assert.deepEqual(state.active.messages.map((message) => message.text), ["u1", "a1", "u2", "a2"]);
});

test("a failed local transaction cannot advance the transcript cursor", async (t) => {
  const root = rootFor(t);
  const engine = new DurableBufferEngine(root, actors, 20, 3600, async () => {});
  t.after(() => engine.shutdown(200));

  engine.ingestTranscript("main", "s1", [u("u1"), a("a1")]);
  const originalCommit = engine.journal.commit.bind(engine.journal);
  let failOnce = true;
  engine.journal.commit = (params) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("disk full");
    }
    return originalCommit(params);
  };

  assert.throws(
    () => engine.ingestTranscript("main", "s1", [u("u1"), a("a1"), u("u2"), a("a2")]),
    /disk full/,
  );
  engine.journal.commit = originalCommit;

  assert.deepEqual(
    engine.ingestTranscript("main", "s1", [u("u1"), a("a1"), u("u2"), a("a2")]),
    [u("u2"), a("a2")],
    "the uncommitted turn is offered again after local durability recovers",
  );
});

test("provider outage does not stop new transcript snapshots entering the disk FIFO", async (t) => {
  const root = rootFor(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const engine = new DurableBufferEngine(root, actors, 2, 3600, async (_agentId, entry) => {
    seen.push(entry.buffer.messages.map((message) => message.text).join(","));
    if (seen.length === 1) await gate;
  });
  t.after(async () => {
    release?.();
    await engine.shutdown(200);
  });

  engine.ingestTranscript("main", "s1", [u("u1"), a("a1")]);
  await waitFor(() => seen.length === 1);
  engine.ingestTranscript("main", "s1", [u("u1"), a("a1"), u("u2"), a("a2")]);
  engine.ingestTranscript("main", "s2", [u("x1"), a("x1a")]);

  assert.equal(seen.length, 1, "same-agent FIFO head blocks remote overtaking");
  assert.ok(engine.queueDepth("main") >= 3, "later batches are durable on disk while provider is stuck");

  release();
  await waitFor(() => seen.length === 3);
  assert.deepEqual(seen, ["u1,a1", "u2,a2", "x1,x1a"]);
});
