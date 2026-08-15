import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BufferEngine, CHECK_INTERVAL_SEC } from "../dist/buffer.js";
import { MIN_BUFFER_TIMEOUT_SEC } from "../dist/config.js";

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

test("QueueEntry.enqueuedAt is the detach time, not buffer creation time", async (t) => {
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  t.after(() => {
    Date.now = originalNow;
  });

  const entries = [];
  const engine = new BufferEngine(agents, 4, 3600, async (_agentId, entry) => {
    entries.push(entry);
  });
  t.after(() => engine.stop());

  engine.addTurn("main", "session", "u1", "a1");
  now += 12_345;
  engine.addTurn("main", "session", "u2", "a2");

  await waitFor(() => entries.length === 1);
  assert.equal(entries[0].enqueuedAt, 1_700_000_012_345);
  assert.equal(entries[0].buffer.createdAt, 1_700_000_000_000);
});

test("ticker floor and OpenClaw manifest use the same public timeout minimum", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  assert.equal(CHECK_INTERVAL_SEC, MIN_BUFFER_TIMEOUT_SEC);
  assert.equal(manifest.configSchema.properties.bufferTimeout.minimum, MIN_BUFFER_TIMEOUT_SEC);
  assert.equal(manifest.configSchema.properties.bufferLimit.multipleOf, 2);
});
