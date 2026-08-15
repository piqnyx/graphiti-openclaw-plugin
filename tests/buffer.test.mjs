import test from "node:test";
import assert from "node:assert/strict";
import { BufferEngine, CHECK_INTERVAL_SEC } from "../dist/buffer.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail("condition was not met before timeout");
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const agents = {
  main: { user: "Вит", assistant: "Краб" },
};

function addTurn(engine, agentId, sessionKey, n) {
  engine.addTurn(agentId, sessionKey, `user-${n}`, `assistant-${n}`);
}

test("odd bufferLimit is rejected so a completed turn cannot be split", () => {
  assert.throws(
    () => new BufferEngine(agents, 3, 3600, async () => {}),
    /bufferLimit must be an even integer/,
  );
});

test("limit trigger flushes exactly at an even message limit", async (t) => {
  const flushes = [];
  const engine = new BufferEngine(agents, 4, 3600, async (agentId, entry, reason) => {
    flushes.push({
      agentId,
      sessionKey: entry.buffer.sessionKey,
      count: entry.buffer.messages.length,
      roles: entry.buffer.messages.map((m) => m.role),
      reason,
    });
  });
  t.after(() => engine.stop());

  addTurn(engine, "main", "s1", 1);
  await sleep(20);
  assert.equal(flushes.length, 0);

  addTurn(engine, "main", "s1", 2);
  await waitFor(() => flushes.length === 1, 2000);
  assert.deepEqual(flushes[0], {
    agentId: "main",
    sessionKey: "s1",
    count: 4,
    roles: ["user", "assistant", "user", "assistant"],
    reason: "limit",
  });
  assert.equal(engine.activeBufferCount("main"), 1);
  assert.equal(engine.queueLength(), 0);
});

test("buffers are isolated per session within an agent", () => {
  const flushes = [];
  const engine = new BufferEngine(agents, 4, 3600, async (_agentId, entry) => {
    flushes.push(entry.buffer.sessionKey);
  });
  try {
    addTurn(engine, "main", "sA", 1);
    addTurn(engine, "main", "sB", 2);
    assert.equal(engine.activeBufferCount("main"), 2);
    assert.equal(flushes.length, 0);
  } finally {
    engine.stop();
  }
});

test("FIFO queue per agent preserves chronological order", async (t) => {
  const flushes = [];
  const gate = deferred();
  const engine = new BufferEngine(agents, 2, 3600, async (_agentId, entry) => {
    flushes.push(entry.buffer.sessionKey);
    if (flushes.length === 1) await gate.promise;
  });
  t.after(() => engine.stop());

  addTurn(engine, "main", "first", 1);
  addTurn(engine, "main", "second", 2);

  await waitFor(() => flushes.length === 1, 2000);
  gate.resolve();
  await waitFor(() => flushes.length === 2, 2000);
  assert.deepEqual(flushes, ["first", "second"]);
});

test("agents are isolated: one agent processing slot does not affect another", async (t) => {
  const flushes = [];
  const gate = deferred();
  const engine = new BufferEngine(agents, 2, 3600, async (agentId, entry) => {
    flushes.push({ agentId, sessionKey: entry.buffer.sessionKey });
    if (agentId === "igor") await gate.promise;
  });
  t.after(() => engine.stop());

  addTurn(engine, "igor", "i1", 1);
  await waitFor(() => flushes.some((f) => f.agentId === "igor"), 2000);

  addTurn(engine, "main", "m1", 1);
  await waitFor(() => flushes.some((f) => f.agentId === "main"), 2000);

  gate.resolve();
  assert.ok(flushes.some((f) => f.agentId === "main"));
});

test("failed sink drops only that detached buffer and reports the error", async (t) => {
  const errors = [];
  const engine = new BufferEngine(
    agents,
    2,
    3600,
    async () => {
      throw new Error("backend down");
    },
    {
      notifyError: (agentId, sessionKey, _reason, error) =>
        errors.push({ agentId, sessionKey, error: error.message }),
    },
  );
  t.after(() => engine.stop());

  addTurn(engine, "main", "s1", 1);
  await waitFor(() => errors.length === 1, 2000);
  assert.equal(engine.queueLength(), 0);
  assert.deepEqual(errors, [{ agentId: "main", sessionKey: "s1", error: "backend down" }]);
});

test("timeout ticker flushes a complete turn exactly after the configured inactivity", async (t) => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalNow = Date.now;
  let scheduled;
  let scheduledMs;
  let now = 1_700_000_000_000;

  globalThis.setInterval = (callback, ms) => {
    scheduled = callback;
    scheduledMs = ms;
    return { unref() {} };
  };
  globalThis.clearInterval = () => {};
  Date.now = () => now;
  t.after(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    Date.now = originalNow;
  });

  const flushes = [];
  const engine = new BufferEngine(agents, 50, 30, async (_agentId, entry, reason) => {
    flushes.push({
      sessionKey: entry.buffer.sessionKey,
      count: entry.buffer.messages.length,
      reason,
      enqueuedAt: entry.enqueuedAt,
    });
  });

  assert.equal(scheduledMs, CHECK_INTERVAL_SEC * 1000);
  addTurn(engine, "main", "session-a", 1);

  now += 29_999;
  scheduled();
  await sleep(0);
  assert.equal(flushes.length, 0);

  now += 1;
  scheduled();
  await waitFor(() => flushes.length === 1, 500);
  assert.deepEqual(flushes[0], {
    sessionKey: "session-a",
    count: 2,
    reason: "timeout",
    enqueuedAt: now,
  });
  assert.equal(engine.activeBufferCount("main"), 0);
});
