import test from "node:test";
import assert from "node:assert/strict";
import { AgentTurnBuffer } from "../dist/buffer.js";

const turn = (name) => ({ user: `user-${name}`, assistant: `assistant-${name}` });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail("condition was not met before timeout");
}

test("a retry-blocked agent does not prevent another agent idle flush", async () => {
  const attempts = [];
  const buffer = new AgentTurnBuffer(2, 40, async (agentId, turns, reason) => {
    attempts.push({ agentId, users: turns.map((item) => item.user), reason });
    if (agentId === "broken") throw new Error("backend unavailable for broken agent");
  });

  buffer.add("broken", turn("b1"));
  buffer.add("broken", turn("b2"));
  await waitFor(() => attempts.some((item) => item.agentId === "broken"));
  await waitFor(() => buffer.bufferedTurns("broken") === 2);

  buffer.add("healthy", turn("h1"));
  await waitFor(() => attempts.some((item) => item.agentId === "healthy"));

  const healthy = attempts.find((item) => item.agentId === "healthy");
  assert.deepEqual(healthy, { agentId: "healthy", users: ["user-h1"], reason: "idle" });
  assert.equal(buffer.bufferedTurns("broken"), 2);
  assert.equal(buffer.bufferedTurns("healthy"), 0);
});
