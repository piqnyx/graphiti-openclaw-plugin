import test from "node:test";
import assert from "node:assert/strict";
import { BufferEngine } from "../dist/buffer.js";

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

test("a failing agent does not block another agent's flush", async (t) => {
  const flushes = [];
  const errors = [];
  const engine = new BufferEngine(
    agents,
    2,
    3600,
    async (agentId, entry) => {
      flushes.push({ agentId, sessionKey: entry.buffer.sessionKey });
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

  addTurn(engine, "healthy", "h1", 1);
  await waitFor(() => flushes.some((f) => f.agentId === "healthy"), 2000);

  assert.deepEqual(
    flushes.find((f) => f.agentId === "healthy"),
    { agentId: "healthy", sessionKey: "h1" },
  );
  assert.equal(errors.length, 1);
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
