import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableBufferEngine } from "../dist/durable-buffer-engine.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail("condition was not met before timeout");
}

function watermark(agentId, sessionKey, observedMessages = 1) {
  return {
    agentId,
    sessionKey,
    tailHashes: ["a".repeat(64)],
    observedMessages,
    prefixDigest: "b".repeat(64),
    updatedAt: Date.now(),
  };
}

function withRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "graphiti-durable-engine-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const actors = {
  main: { user: "Вит", assistant: "Краб" },
  igor: { user: "Игорь", assistant: "Краб" },
};

test("later batches keep entering disk FIFO while the provider head is stuck", async (t) => {
  const root = withRoot(t);
  let releaseHead;
  const headGate = new Promise((resolve) => { releaseHead = resolve; });
  const started = [];

  const engine = new DurableBufferEngine(root, actors, 1, 30, async (_agentId, entry) => {
    const text = entry.buffer.messages[0].text;
    started.push(text);
    if (text === "head") await headGate;
  });
  t.after(async () => {
    releaseHead?.();
    await engine.shutdown(500);
  });

  engine.ingest("main", "s1", [{ role: "user", text: "head" }], watermark("main", "s1"));
  await waitFor(() => started.length === 1);

  for (let i = 0; i < 25; i += 1) {
    engine.ingest(
      "main",
      i % 2 === 0 ? "s1" : "s2",
      [{ role: "user", text: `queued-${i}` }],
      watermark("main", i % 2 === 0 ? "s1" : "s2", i + 2),
    );
  }

  assert.deepEqual(started, ["head"], "later work never overtakes the blocked head");
  assert.ok(engine.queueDepth("main") >= 26, "blocked provider does not stop local durable enqueue");

  releaseHead();
  await waitFor(() => started.length === 26);
  assert.deepEqual(started.slice(1), Array.from({ length: 25 }, (_, i) => `queued-${i}`));
});

test("switching dialogs keeps separate active buffers and detaches each into its own saga payload", async (t) => {
  const root = withRoot(t);
  const delivered = [];
  const engine = new DurableBufferEngine(root, actors, 3, 30, async (_agentId, entry) => {
    delivered.push({
      sessionKey: entry.buffer.sessionKey,
      messages: entry.buffer.messages.map((message) => message.text),
    });
  });
  t.after(() => engine.shutdown(500));

  engine.ingest("main", "fishing", [{ role: "user", text: "коплю на лодку" }], watermark("main", "fishing", 1));
  engine.ingest(
    "main",
    "work",
    [
      { role: "user", text: "заработал денег" },
      { role: "assistant", text: "отлично" },
    ],
    watermark("main", "work", 2),
  );

  assert.equal(engine.activeBufferCount("main"), 2, "dialog switch must not replace the other dialog's partial buffer");
  assert.equal(delivered.length, 0);

  engine.ingest(
    "main",
    "fishing",
    [
      { role: "assistant", text: "лодка подождёт" },
      { role: "user", text: "продолжаю копить" },
    ],
    watermark("main", "fishing", 3),
  );
  await waitFor(() => delivered.length === 1);
  assert.deepEqual(delivered[0], {
    sessionKey: "fishing",
    messages: ["коплю на лодку", "лодка подождёт", "продолжаю копить"],
  });
  assert.equal(engine.activeBufferCount("main"), 1, "work dialog must remain open after fishing detaches");

  engine.ingest(
    "main",
    "work",
    [{ role: "user", text: "теперь хватит на покупку" }],
    watermark("main", "work", 3),
  );
  await waitFor(() => delivered.length === 2);
  assert.deepEqual(delivered[1], {
    sessionKey: "work",
    messages: ["заработал денег", "отлично", "теперь хватит на покупку"],
  });
});

test("sessions share one agent FIFO but different agents drain independently", async (t) => {
  const root = withRoot(t);
  let releaseMain;
  const mainGate = new Promise((resolve) => { releaseMain = resolve; });
  const seen = [];

  const engine = new DurableBufferEngine(root, actors, 1, 30, async (agentId, entry) => {
    const value = `${agentId}:${entry.buffer.sessionKey}:${entry.buffer.messages[0].text}`;
    seen.push(value);
    if (agentId === "main" && entry.buffer.messages[0].text === "m1") await mainGate;
  });
  t.after(async () => {
    releaseMain?.();
    await engine.shutdown(500);
  });

  engine.ingest("main", "topic-a", [{ role: "user", text: "m1" }], watermark("main", "topic-a"));
  await waitFor(() => seen.includes("main:topic-a:m1"));
  engine.ingest("main", "topic-b", [{ role: "user", text: "m2" }], watermark("main", "topic-b"));
  engine.ingest("igor", "topic-x", [{ role: "user", text: "i1" }], watermark("igor", "topic-x"));

  await waitFor(() => seen.includes("igor:topic-x:i1"));
  assert.equal(seen.includes("main:topic-b:m2"), false, "same-agent session cannot bypass its predecessor");

  releaseMain();
  await waitFor(() => seen.includes("main:topic-b:m2"));
});

test("reserved Graphiti identity is fsynced on the head and survives restart", async (t) => {
  const root = withRoot(t);
  const identity = {
    uuid: "11111111-1111-4111-8111-111111111111",
    name: "dialog-1",
    batchNumber: 1,
    submittedAt: 1234,
  };
  let firstAttempt = true;

  const first = new DurableBufferEngine(root, actors, 1, 30, async (_agentId, entry, _reason, controls) => {
    if (!firstAttempt) return;
    firstAttempt = false;
    entry.episode = { ...identity };
    controls.checkpoint();
    throw new Error("provider unavailable after identity reservation");
  });
  first.ingest("main", "dialog", [{ role: "user", text: "hello" }], watermark("main", "dialog"));
  await waitFor(() => firstAttempt === false);
  await first.shutdown(500);

  let restored;
  const second = new DurableBufferEngine(root, actors, 1, 30, async (_agentId, entry) => {
    restored = entry;
  });
  t.after(() => second.shutdown(500));
  await waitFor(() => restored !== undefined);

  assert.deepEqual(restored.episode, identity);
  assert.equal(restored.identityRestored, true);
  assert.equal(restored.buffer.messages[0].text, "hello");
});

test("local journal failure prevents any remote side effect", async (t) => {
  const root = withRoot(t);
  let remoteCalls = 0;
  const engine = new DurableBufferEngine(root, actors, 1, 30, async () => {
    remoteCalls += 1;
  });
  t.after(() => engine.shutdown(500));

  const originalCommit = engine.journal.commit.bind(engine.journal);
  engine.journal.commit = () => {
    throw new Error("disk full");
  };

  assert.throws(
    () => engine.ingest("main", "s1", [{ role: "user", text: "must stay local" }], watermark("main", "s1")),
    /disk full/,
  );
  await sleep(30);
  assert.equal(remoteCalls, 0);
  engine.journal.commit = originalCommit;
});

test("partial buffer flushes on inactivity without moving its durable watermark", async (t) => {
  const root = withRoot(t);
  const delivered = [];
  const engine = new DurableBufferEngine(root, actors, 20, 30, async (_agentId, entry) => {
    delivered.push(entry);
  });
  t.after(() => engine.shutdown(500));

  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });

  const mark = { ...watermark("main", "s1"), updatedAt: now };
  engine.ingest("main", "s1", [{ role: "user", text: "partial" }], mark);
  assert.equal(engine.activeBufferCount("main"), 1);
  assert.equal(delivered.length, 0);

  now += 31_000;
  await engine.tick();
  await waitFor(() => delivered.length === 1);

  assert.equal(delivered[0].reason, "timeout");
  assert.equal(delivered[0].buffer.messages[0].text, "partial");
  const state = engine.journal.read("main", "s1").committed;
  assert.equal(state.active, undefined);
  assert.deepEqual(state.watermark, mark);
});

test("a synthetic note joins the same session buffer without advancing transcript cursor", async (t) => {
  const root = withRoot(t);
  const engine = new DurableBufferEngine(root, actors, 20, 30, async () => {});
  t.after(() => engine.shutdown(500));

  const mark = watermark("main", "s1", 8);
  engine.ingest("main", "s1", [{ role: "user", text: "ordinary" }], mark);
  engine.appendSynthetic("main", "s1", { role: "assistant", text: "remember this" });

  const state = engine.journal.read("main", "s1").committed;
  assert.deepEqual(state.watermark, mark);
  assert.deepEqual(state.active.messages.map((m) => m.text), ["ordinary", "remember this"]);
});
