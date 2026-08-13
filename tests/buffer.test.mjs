import test from "node:test";
import assert from "node:assert/strict";
import { AgentTurnBuffer } from "../dist/buffer.js";

const makeTurn = (n) => ({ user: `user-${n}`, assistant: `assistant-${n}` });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail("condition was not met before timeout");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("threshold batches are isolated by agentId", async () => {
  const calls = [];
  const buffer = new AgentTurnBuffer(2, 10_000, async (agentId, turns, reason) => {
    calls.push({ agentId, users: turns.map((turn) => turn.user), reason });
  });

  buffer.add("main", makeTurn(1));
  buffer.add("igor", makeTurn(10));
  buffer.add("main", makeTurn(2));

  await waitFor(() => calls.length === 1);
  assert.deepEqual(calls, [
    { agentId: "main", users: ["user-1", "user-2"], reason: "threshold" },
  ]);
  assert.equal(buffer.bufferedTurns("igor"), 1);
});

test("one idle scheduler respects each agent buffer age", async () => {
  const calls = [];
  const buffer = new AgentTurnBuffer(10, 200, async (agentId, turns, reason) => {
    calls.push({ agentId, users: turns.map((turn) => turn.user), reason, at: Date.now() });
  });

  buffer.add("main", makeTurn(1));
  await sleep(80);
  buffer.add("igor", makeTurn(2));

  await waitFor(() => calls.length >= 1);
  assert.equal(calls[0].agentId, "main");
  assert.equal(calls[0].reason, "idle");
  assert.equal(buffer.bufferedTurns("igor"), 1);

  await waitFor(() => calls.length === 2);
  assert.equal(calls[1].agentId, "igor");
  assert.equal(calls[1].reason, "idle");
});

test("turns arriving during a flush form the next intact batch", async () => {
  const firstFlushGate = deferred();
  const batches = [];
  let call = 0;
  const buffer = new AgentTurnBuffer(2, 10_000, async (_agentId, turns) => {
    call += 1;
    batches.push(turns.map((turn) => turn.user));
    if (call === 1) await firstFlushGate.promise;
  });

  buffer.add("main", makeTurn(1));
  buffer.add("main", makeTurn(2));
  await waitFor(() => batches.length === 1);

  buffer.add("main", makeTurn(3));
  buffer.add("main", makeTurn(4));
  assert.equal(buffer.bufferedTurns("main"), 2);

  firstFlushGate.resolve();
  await waitFor(() => batches.length === 2);
  assert.deepEqual(batches, [
    ["user-1", "user-2"],
    ["user-3", "user-4"],
  ]);
});

test("failed flush is retained without autonomous retry and retries after a new turn", async () => {
  const attempts = [];
  let failFirst = true;
  const buffer = new AgentTurnBuffer(2, 40, async (_agentId, turns, reason) => {
    attempts.push({ users: turns.map((turn) => turn.user), reason });
    if (failFirst) {
      failFirst = false;
      throw new Error("temporary unavailable");
    }
  });

  buffer.add("main", makeTurn(1));
  buffer.add("main", makeTurn(2));
  await waitFor(() => attempts.length === 1 && buffer.bufferedTurns("main") === 2);

  await sleep(140);
  assert.equal(attempts.length, 1, "failed batch must not retry on the idle clock by itself");
  assert.equal(buffer.bufferedTurns("main"), 2);

  buffer.add("main", makeTurn(3));
  await waitFor(() => attempts.length === 2);
  assert.deepEqual(attempts[1], {
    users: ["user-1", "user-2", "user-3"],
    reason: "threshold",
  });
  await waitFor(() => buffer.bufferedTurns("main") === 0);
});

test("a new turn arriving while a failed request is in flight permits the next flush", async () => {
  const firstFlushGate = deferred();
  const attempts = [];
  let call = 0;
  const buffer = new AgentTurnBuffer(2, 10_000, async (_agentId, turns) => {
    call += 1;
    attempts.push(turns.map((turn) => turn.user));
    if (call === 1) {
      await firstFlushGate.promise;
      throw new Error("first request failed");
    }
  });

  buffer.add("main", makeTurn(1));
  buffer.add("main", makeTurn(2));
  await waitFor(() => attempts.length === 1);
  buffer.add("main", makeTurn(3));

  firstFlushGate.resolve();
  await waitFor(() => attempts.length === 2);
  assert.deepEqual(attempts, [
    ["user-1", "user-2"],
    ["user-1", "user-2", "user-3"],
  ]);
});
