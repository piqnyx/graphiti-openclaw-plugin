import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BufferEngine } from "../dist/buffer.js";
import { CaptureSpool } from "../dist/capture-spool.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail("condition was not met before timeout");
}

const agents = {
  main: { user: "Вит", assistant: "Краб" },
};

function tempSpool(t) {
  const dir = mkdtempSync(join(tmpdir(), "graphiti-spool-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new CaptureSpool(join(dir, "capture-spool.json"));
}

test("capture spool atomically round-trips pending state and removes empty checkpoints", (t) => {
  const spool = tempSpool(t);
  const snapshot = {
    version: 2,
    agents: [
      {
        agentId: "main",
        activeBuffers: [
          {
            sessionKey: "s1",
            participants: { user: "Вит", assistant: "Краб" },
            messages: [{ role: "user", text: "не потеряй меня" }],
            createdAt: 100,
            lastActivityAt: 200,
          },
        ],
        queue: [],
      },
    ],
    sessions: [
      {
        agentId: "main",
        sessionKey: "s1",
        tailHashes: ["deadbeef", "cafebabe"],
        observedMessages: 7,
        updatedAt: 300,
      },
    ],
  };

  spool.save(snapshot);
  assert.deepEqual(spool.load(), snapshot);
  assert.match(readFileSync(spool.path, "utf8"), /не потеряй меня/);

  spool.save({ version: 2, agents: [], sessions: [] });
  assert.equal(spool.load(), undefined);
});

test("corrupt durable spool is never silently overwritten", (t) => {
  const spool = tempSpool(t);
  writeFileSync(spool.path, "{broken", { encoding: "utf8", flag: "w" });

  assert.throws(() => spool.load(), /refusing to overwrite/);
  assert.equal(readFileSync(spool.path, "utf8"), "{broken");
});

test("partial active buffer survives process-style restart without losing message order", async (t) => {
  const spool = tempSpool(t);

  const first = new BufferEngine(agents, 4, 3600, async () => {
    assert.fail("partial buffer must not flush before restart");
  }, {
    onStateChange: (snapshot) => spool.save({ version: 2, ...snapshot, sessions: [] }),
  });

  first.addMessage("main", "s1", "user", "u1");
  first.addMessage("main", "s1", "assistant", "a1");
  await first.shutdown(0);

  const restored = spool.load();
  assert.ok(restored, "shutdown must leave the partial tail on disk");

  const flushes = [];
  const second = new BufferEngine(agents, 4, 3600, async (_agentId, entry) => {
    flushes.push(entry.buffer.messages.map((message) => `${message.role}:${message.text}`));
  }, {
    initialState: restored,
    onStateChange: (snapshot) => spool.save({ version: 2, ...snapshot, sessions: [] }),
  });
  t.after(() => second.stop());
  second.resumeRestored();

  second.addMessage("main", "s1", "user", "u2");
  second.addMessage("main", "s1", "assistant", "a2");

  await waitFor(() => flushes.length === 1);
  assert.deepEqual(flushes[0], ["user:u1", "assistant:a1", "user:u2", "assistant:a2"]);
  await waitFor(() => spool.load() === undefined);
});

test("failed local FIFO head survives restart and is retried before new work", async (t) => {
  const spool = tempSpool(t);
  const errors = [];
  const first = new BufferEngine(agents, 1, 3600, async () => {
    throw new Error("backend unavailable");
  }, {
    onStateChange: (snapshot) => spool.save({ version: 2, ...snapshot, sessions: [] }),
    notifyError: (_agentId, _sessionKey, _reason, error) => errors.push(error.message),
  });

  first.addMessage("main", "old", "user", "old-message");
  await waitFor(() => errors.length === 1);
  assert.equal(first.queueLength(), 1);
  await first.shutdown(0);

  const restored = spool.load();
  assert.ok(restored);

  const order = [];
  const second = new BufferEngine(agents, 1, 3600, async (_agentId, entry) => {
    order.push(entry.buffer.messages[0].text);
  }, {
    initialState: restored,
    onStateChange: (snapshot) => spool.save({ version: 2, ...snapshot, sessions: [] }),
  });
  t.after(() => second.stop());

  second.resumeRestored();
  second.addMessage("main", "new", "user", "new-message");

  await waitFor(() => order.length === 2);
  assert.deepEqual(order, ["old-message", "new-message"]);
  await waitFor(() => spool.load() === undefined);
});

test("a version 1 spool from an older gateway is migrated, not rejected", (t) => {
  const spool = tempSpool(t);
  const legacy = {
    version: 1,
    agents: [
      {
        agentId: "main",
        activeBuffers: [],
        queue: [
          {
            buffer: {
              sessionKey: "s1",
              participants: { user: "Вит", assistant: "Краб" },
              messages: [{ role: "user", text: "написано старой версией" }],
              createdAt: 100,
              lastActivityAt: 200,
            },
            enqueuedAt: 200,
            reason: "limit",
          },
        ],
      },
    ],
  };
  writeFileSync(spool.path, `${JSON.stringify(legacy)}\n`, { encoding: "utf8", flag: "w" });

  const restored = spool.load();
  assert.equal(restored.version, 2);
  assert.deepEqual(restored.sessions, []);
  assert.deepEqual(
    restored.agents[0].queue[0].buffer.messages,
    [{ role: "user", text: "написано старой версией" }],
    "unaccepted batches survive the schema upgrade",
  );
});

test("session watermarks alone keep the spool alive", (t) => {
  const spool = tempSpool(t);
  spool.save({
    version: 2,
    agents: [],
    sessions: [
      { agentId: "main", sessionKey: "s1", tailHashes: ["abc12345"], observedMessages: 4, updatedAt: 1 },
    ],
  });

  const restored = spool.load();
  assert.equal(restored.sessions.length, 1);
  assert.equal(restored.agents.length, 0);
});
