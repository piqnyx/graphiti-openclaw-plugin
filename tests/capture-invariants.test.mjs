import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECK_INTERVAL_SEC } from "../dist/buffer.js";
import { MIN_BUFFER_TIMEOUT_SEC } from "../dist/config.js";
import { DurableBufferEngine } from "../dist/durable-buffer-engine.js";

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

function rootFor(t) {
  const root = mkdtempSync(join(tmpdir(), "graphiti-capture-invariant-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function watermark(observedMessages) {
  return {
    agentId: "main",
    sessionKey: "session",
    tailHashes: [String(observedMessages).padStart(64, "0")],
    observedMessages,
    prefixDigest: "f".repeat(64),
    updatedAt: Date.now(),
  };
}

test("QueueEntry.enqueuedAt is the detach time, not buffer creation time", async (t) => {
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });

  const entries = [];
  const engine = new DurableBufferEngine(rootFor(t), agents, 4, 3600, async (_agentId, entry) => {
    entries.push(entry);
  });
  t.after(() => engine.shutdown(200));

  engine.ingest("main", "session", [{ role: "user", text: "u1" }], watermark(1));
  now += 12_345;
  engine.ingest(
    "main",
    "session",
    [
      { role: "assistant", text: "a1" },
      { role: "user", text: "u2" },
      { role: "assistant", text: "a2" },
    ],
    watermark(4),
  );

  await waitFor(() => entries.length === 1);
  assert.equal(entries[0].enqueuedAt, 1_700_000_012_345);
  assert.equal(entries[0].buffer.createdAt, 1_700_000_000_000);
});

test("ticker floor and manifest use the same public timeout minimum", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  assert.equal(CHECK_INTERVAL_SEC, MIN_BUFFER_TIMEOUT_SEC);
  assert.equal(manifest.configSchema.properties.bufferTimeout.minimum, MIN_BUFFER_TIMEOUT_SEC);
  assert.equal(manifest.configSchema.properties.bufferLimit.minimum, 1);
  assert.equal("multipleOf" in manifest.configSchema.properties.bufferLimit, false);
});

test("odd message limits are valid and flush exact message order", async (t) => {
  const entries = [];
  const engine = new DurableBufferEngine(rootFor(t), agents, 3, 3600, async (_agentId, entry) => {
    entries.push(entry);
  });
  t.after(() => engine.shutdown(200));

  engine.ingest(
    "main",
    "session",
    [
      { role: "user", text: "u1" },
      { role: "user", text: "u2" },
      { role: "assistant", text: "a1" },
    ],
    watermark(3),
  );

  await waitFor(() => entries.length === 1);
  assert.deepEqual(entries[0].buffer.messages, [
    { role: "user", text: "u1" },
    { role: "user", text: "u2" },
    { role: "assistant", text: "a1" },
  ]);
});
