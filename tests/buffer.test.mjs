import test from "node:test";
import assert from "node:assert/strict";
import { AgentTurnBuffer } from "../dist/buffer.js";

const makeTurn = (n) => ({ user: `user-${n}`, assistant: `assistant-${n}` });
const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test("threshold counts completed turns per agent", async () => {
  const calls = [];
  const buffer = new AgentTurnBuffer(2, 10000, async (agentId, turns, reason) => {
    calls.push({ agentId, count: turns.length, reason });
  });
  buffer.add("main", makeTurn(1));
  buffer.add("igor", makeTurn(1));
  buffer.add("main", makeTurn(2));
  await wait();
  assert.deepEqual(calls, [{ agentId: "main", count: 2, reason: "threshold" }]);
  assert.equal(buffer.bufferedTurns("igor"), 1);
});

test("threshold one sends every completed turn", async () => {
  const calls = [];
  const buffer = new AgentTurnBuffer(1, 10000, async (agentId, turns) => {
    calls.push([agentId, turns.length]);
  });
  buffer.add("main", makeTurn(1));
  await wait();
  assert.deepEqual(calls, [["main", 1]]);
});

test("idle timeout sends a partial batch", async () => {
  const calls = [];
  const buffer = new AgentTurnBuffer(10, 20, async (agentId, turns, reason) => {
    calls.push([agentId, turns.length, reason]);
  });
  buffer.add("main", makeTurn(1));
  await wait(60);
  assert.deepEqual(calls, [["main", 1, "idle"]]);
});

test("a failed send restores buffered turns", async () => {
  const buffer = new AgentTurnBuffer(2, 10000, async () => {
    throw new Error("temporary unavailable");
  });
  buffer.add("main", makeTurn(1));
  buffer.add("main", makeTurn(2));
  await wait();
  assert.equal(buffer.bufferedTurns("main"), 2);
});
