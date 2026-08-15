import test from "node:test";
import assert from "node:assert/strict";
import { BufferEngine, CHECK_INTERVAL_SEC } from "../dist/buffer.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  assert.fail("condition was not met before timeout");
}

const agents = {
  main: { user: "Вит", assistant: "Краб" },
};

function addTurn(engine, agentId, sessionKey, n) {
  engine.addTurn(agentId, sessionKey, `user-${n}`, `assistant-${n}`);
}

test("one agent processing sequentially drains its whole queue in a single pass", async (t) => {
  const order = [];
  const gate = deferred();
  let released = 0;

  const engine = new BufferEngine(
    agents,
    2,
    3600,
    async (_agentId, entry) => {
      order.push(entry.buffer.sessionKey);
      if (order.length === 1) await gate.promise;
      released += 1;
    },
  );
  t.after(() => engine.stop());

  for (const s of ["a", "b", "c"]) {
    addTurn(engine, "main", s, 1);
  }

  await waitFor(() => order.length === 1, 2000);
  gate.resolve();
  await waitFor(() => order.length === 3, 2000);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(released, 3);
});

test("a failed agent retains its FIFO head while another agent continues", async (t) => {
  const attempts = [];
  const errors = [];
  const engine = new BufferEngine(
    agents,
    2,
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
  t.after(() => engine.stop());

  addTurn(engine, "broken", "b1", 1);
  await waitFor(() => errors.length === 1, 2000);
  assert.equal(engine.queueLength(), 1, "failed head must stay queued");

  addTurn(engine, "healthy", "h1", 1);
  await waitFor(() => attempts.some((f) => f.agentId === "healthy"), 2000);

  assert.deepEqual(
    attempts.find((f) => f.agentId === "healthy"),
    { agentId: "healthy", sessionKey: "h1" },
  );
  assert.equal(errors.length, 1, "one failure incident emits one notification");
  assert.equal(engine.queueLength(), 1, "only broken agent head remains queued");
});

test("failed head retries before later entries and recovery resumes FIFO", async (t) => {
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  t.after(() => {
    Date.now = originalNow;
  });

  const attempts = [];
  const errors = [];
  const recovered = [];
  let firstAttempts = 0;

  const engine = new BufferEngine(
    agents,
    2,
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
  t.after(() => engine.stop());

  addTurn(engine, "main", "b1", 1);
  await sleep(0);
  assert.deepEqual(attempts, ["b1"]);
  assert.deepEqual(errors, ["b1"]);
  assert.equal(engine.queueLength(), 1);

  // Queue a later item while retry backoff is active. It must not overtake b1.
  addTurn(engine, "main", "b2", 2);
  await sleep(0);
  assert.deepEqual(attempts, ["b1"]);
  assert.equal(engine.queueLength(), 2);

  now += CHECK_INTERVAL_SEC * 1000;
  // A new enqueue is enough to kick pump after retryAfter; the real ticker does
  // the same in production.
  addTurn(engine, "main", "b3", 3);
  await sleep(0);
  await sleep(0);

  assert.deepEqual(attempts, ["b1", "b1", "b2", "b3"]);
  assert.deepEqual(recovered, ["b1"]);
  assert.equal(engine.queueLength(), 0);
});

test("BufferEngine accepts only complete turns, so half-turn buffers are unrepresentable", async (t) => {
  const flushes = [];
  const engine = new BufferEngine(
    agents,
    4,
    3600,
    async (_agentId, entry) => {
      flushes.push(entry.buffer.messages.map((m) => m.role));
    },
  );
  t.after(() => engine.stop());

  assert.equal(typeof engine.addMessage, "undefined");

  addTurn(engine, "main", "s1", 1);
  await sleep(100);
  assert.equal(flushes.length, 0);

  addTurn(engine, "main", "s1", 2);
  await waitFor(() => flushes.length === 1, 2000);
  assert.deepEqual(flushes[0], ["user", "assistant", "user", "assistant"]);
});

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
