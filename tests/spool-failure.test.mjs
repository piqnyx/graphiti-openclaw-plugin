import test from "node:test";
import assert from "node:assert/strict";
import { BufferEngine } from "../dist/buffer.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail("condition was not met before timeout");
}

const agents = { main: { user: "Вит", assistant: "Краб" } };

test("a failed spool write never drops the rest of an observed delta", (t) => {
  const persistErrors = [];
  const engine = new BufferEngine(agents, 8, 3600, async () => {}, {
    onStateChange: () => {
      throw new Error("EACCES: permission denied");
    },
    notifyPersistError: (error) => persistErrors.push(error.message),
  });
  t.after(() => engine.stop());

  engine.addMessages("main", "s1", [
    { role: "user", text: "u1" },
    { role: "assistant", text: "a1" },
    { role: "user", text: "u2" },
  ]);

  assert.deepEqual(
    engine.snapshot().agents[0].activeBuffers[0].messages.map((message) => message.text),
    ["u1", "a1", "u2"],
    "every observed message stays in memory when the checkpoint fails",
  );
  assert.equal(persistErrors.length, 1, "the checkpoint failure is reported exactly once");
});

test("spool write failures are reported and recovered independently of capture", async (t) => {
  const persistErrors = [];
  const recovered = [];
  let failWrites = true;
  const engine = new BufferEngine(agents, 8, 3600, async () => {}, {
    onStateChange: () => {
      if (failWrites) throw new Error("ENOSPC: no space left on device");
    },
    notifyPersistError: (error) => persistErrors.push(error.message),
    notifyPersistRecovered: () => recovered.push(Date.now()),
  });
  t.after(() => engine.stop());

  engine.addMessage("main", "s1", "user", "u1");
  engine.addMessage("main", "s1", "assistant", "a1");
  assert.equal(persistErrors.length, 1, "repeated failures are not repeated notifications");

  failWrites = false;
  engine.addMessage("main", "s1", "user", "u2");
  assert.equal(recovered.length, 1);
  await sleep(0);
});

test("a checkpoint failure after acceptance is not reported as a capture failure", async (t) => {
  const delivered = [];
  const captureErrors = [];
  let saves = 0;
  const engine = new BufferEngine(agents, 1, 3600, async (_agentId, entry) => {
    delivered.push(entry.buffer.messages[0].text);
  }, {
    onStateChange: () => {
      saves += 1;
      // The checkpoint that follows a successful delivery.
      if (saves === 2) throw new Error("ENOSPC: no space left on device");
    },
    notifyError: (_agentId, _sessionKey, _reason, error) => captureErrors.push(error.message),
  });
  t.after(() => engine.stop());

  engine.addMessage("main", "s1", "user", "m1");

  await waitFor(() => delivered.length === 1);
  assert.equal(engine.queueLength(), 0, "the accepted entry leaves the queue");
  assert.deepEqual(captureErrors, [], "a local spool problem is never a delivery failure");
});
