import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECK_INTERVAL_SEC } from "../dist/buffer.js";
import { DurableBufferEngine } from "../dist/durable-buffer-engine.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  assert.fail("condition was not met before timeout");
}

const agents = {
  main: { user: "Вит", assistant: "Краб" },
  broken: { user: "Broken", assistant: "Краб" },
  healthy: { user: "Healthy", assistant: "Краб" },
};

function rootFor(t) {
  const root = mkdtempSync(join(tmpdir(), "graphiti-buffer-scheduler-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function mark(agentId, sessionKey, observedMessages = 1) {
  return {
    sessionId: `${agentId}:${sessionKey}`,
    lastSeq: observedMessages - 1,
    capturedEventIds: Array.from({ length: observedMessages }, (_, i) => `e${i}`),
  };
}

function enqueueOne(engine, agentId, sessionKey, text) {
  engine.ingest(
    agentId,
    sessionKey,
    [{ role: "user", text }],
    mark(agentId, sessionKey),
  );
}

test("one agent sequentially drains its whole disk queue", async (t) => {
  const order = [];
  const gate = deferred();
  let released = 0;

  const engine = new DurableBufferEngine(rootFor(t), agents, 1, 3600, async (_agentId, entry) => {
    order.push(entry.buffer.sessionKey);
    if (order.length === 1) await gate.promise;
    released += 1;
  });
  t.after(async () => {
    gate.resolve();
    await engine.shutdown(200);
  });

  for (const s of ["a", "b", "c"]) enqueueOne(engine, "main", s, `message-${s}`);

  await waitFor(() => order.length === 1);
  gate.resolve();
  await waitFor(() => order.length === 3);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(released, 3);
  assert.equal(engine.queueDepth("main"), 0);
});

test("a failed agent retains its head while another agent continues", async (t) => {
  const attempts = [];
  const errors = [];
  const engine = new DurableBufferEngine(
    rootFor(t),
    agents,
    1,
    3600,
    async (agentId, entry) => {
      attempts.push({ agentId, sessionKey: entry.buffer.sessionKey });
      if (agentId === "broken") throw new Error("backend unavailable for broken agent");
    },
    {
      notifyError: (agentId, sessionKey, _reason, error) =>
        errors.push({ agentId, sessionKey, error: error.message }),
    },
  );
  t.after(() => engine.shutdown(200));

  enqueueOne(engine, "broken", "b1", "broken");
  await waitFor(() => errors.length === 1);
  assert.equal(engine.queueDepth("broken"), 1);

  enqueueOne(engine, "healthy", "h1", "healthy");
  await waitFor(() => attempts.some((f) => f.agentId === "healthy"));

  assert.deepEqual(
    attempts.find((f) => f.agentId === "healthy"),
    { agentId: "healthy", sessionKey: "h1" },
  );
  assert.equal(errors.length, 1);
  assert.equal(engine.queueDepth("broken"), 1);
  assert.equal(engine.queueDepth("healthy"), 0);
});

test("failed head retries before later entries and recovery resumes FIFO", async (t) => {
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });

  const attempts = [];
  const errors = [];
  const recovered = [];
  let firstAttempts = 0;

  const engine = new DurableBufferEngine(
    rootFor(t),
    agents,
    1,
    3600,
    async (_agentId, entry) => {
      attempts.push(entry.buffer.sessionKey);
      if (entry.buffer.sessionKey === "b1") {
        firstAttempts += 1;
        if (firstAttempts === 1) throw new Error("temporary failure");
      }
    },
    {
      notifyError: (_agentId, sessionKey) => errors.push(sessionKey),
      notifyRecovered: (_agentId, sessionKey) => recovered.push(sessionKey),
    },
  );
  t.after(() => engine.shutdown(200));

  enqueueOne(engine, "main", "b1", "first");
  await sleep(0);
  assert.deepEqual(attempts, ["b1"]);
  assert.deepEqual(errors, ["b1"]);
  assert.equal(engine.queueDepth("main"), 1);

  enqueueOne(engine, "main", "b2", "second");
  await sleep(0);
  assert.deepEqual(attempts, ["b1"]);
  assert.equal(engine.queueDepth("main"), 2);

  now += CHECK_INTERVAL_SEC * 1000;
  enqueueOne(engine, "main", "b3", "third");
  await waitFor(() => attempts.length === 4);

  assert.deepEqual(attempts, ["b1", "b1", "b2", "b3"]);
  assert.deepEqual(recovered, ["b1"]);
  assert.equal(engine.queueDepth("main"), 0);
});

test("individual user and assistant messages preserve exact order", async (t) => {
  const flushes = [];
  const engine = new DurableBufferEngine(rootFor(t), agents, 4, 3600, async (_agentId, entry) => {
    flushes.push(entry.buffer.messages.map((m) => `${m.role}:${m.text}`));
  });
  t.after(() => engine.shutdown(200));

  engine.ingest(
    "main",
    "s1",
    [
      { role: "user", text: "u1" },
      { role: "user", text: "u2" },
      { role: "user", text: "u3" },
    ],
    mark("main", "s1", 3),
  );
  await sleep(30);
  assert.equal(flushes.length, 0);

  engine.ingest(
    "main",
    "s1",
    [{ role: "assistant", text: "a1" }],
    mark("main", "s1", 4),
  );
  await waitFor(() => flushes.length === 1);
  assert.deepEqual(flushes[0], ["user:u1", "user:u2", "user:u3", "assistant:a1"]);
});

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}
