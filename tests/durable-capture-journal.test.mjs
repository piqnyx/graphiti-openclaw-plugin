import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableCaptureJournal } from "../dist/durable-capture-journal.js";
import { durableAgentKey } from "../dist/durable-queue-store.js";

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function withJournal(t) {
  const root = mkdtempSync(join(tmpdir(), "graphiti-capture-journal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, journal: new DurableCaptureJournal(root) };
}

function batch(name) {
  return {
    captureId: digest(name),
    enqueuedAt: Date.now(),
    payload: { name, body: `body:${name}` },
  };
}

test("session state and all produced batches become durable together", (t) => {
  const { root, journal } = withJournal(t);
  const final = journal.commit({
    agentId: "main",
    sessionKey: "dialog-1",
    initialState: { cursor: 0, active: [] },
    finalState: { cursor: 40, active: ["tail"] },
    batches: [batch("one"), batch("two")],
  });

  assert.deepEqual(final.committed, { cursor: 40, active: ["tail"] });
  assert.equal(final.pending, undefined);

  const restarted = new DurableCaptureJournal(root);
  assert.deepEqual(restarted.read("main", "dialog-1")?.committed, {
    cursor: 40,
    active: ["tail"],
  });
  assert.equal(restarted.queue.peekHead("main")?.payload.name, "one");
  restarted.queue.removeHead("main", 1);
  assert.equal(restarted.queue.peekHead("main")?.payload.name, "two");
});

test("crash halfway through publishing a transaction is completed idempotently on restart", (t) => {
  const { root, journal } = withJournal(t);
  const originalPublish = journal.queue.publish.bind(journal.queue);
  let calls = 0;
  journal.queue.publish = (record) => {
    calls += 1;
    if (calls === 2) throw new Error("simulated crash between queue records");
    return originalPublish(record);
  };

  assert.throws(
    () =>
      journal.commit({
        agentId: "main",
        sessionKey: "dialog-1",
        initialState: { cursor: 0 },
        finalState: { cursor: 40 },
        batches: [batch("one"), batch("two")],
      }),
    /simulated crash/,
  );

  // The committed cursor is intentionally still old while an fsynced intent exists.
  const sessionHash = digest("dialog-1");
  const path = join(root, "sessions", durableAgentKey("main"), `${sessionHash}.json`);
  const rawBefore = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(rawBefore.committed, { cursor: 0 });
  assert.equal(rawBefore.pending.records.length, 2);

  const restarted = new DurableCaptureJournal(root);
  assert.deepEqual(restarted.recoverAll(), { sessions: 1, transactions: 1, records: 2 });
  assert.deepEqual(restarted.read("main", "dialog-1")?.committed, { cursor: 40 });

  assert.equal(restarted.queue.peekHead("main")?.payload.name, "one");
  restarted.queue.removeHead("main", 1);
  assert.equal(restarted.queue.peekHead("main")?.payload.name, "two");
});

test("a state-only cursor/partial-buffer checkpoint does not touch the FIFO", (t) => {
  const { journal } = withJournal(t);
  journal.commit({
    agentId: "main",
    sessionKey: "dialog-1",
    initialState: { cursor: 0, active: [] },
    finalState: { cursor: 3, active: ["u", "a"] },
    batches: [],
  });

  assert.equal(journal.queue.peekHead("main"), undefined);
  assert.deepEqual(journal.read("main", "dialog-1")?.committed, {
    cursor: 3,
    active: ["u", "a"],
  });
});

test("the session journal never grows with the already queued backlog", (t) => {
  const { root, journal } = withJournal(t);
  for (let i = 0; i < 50; i += 1) {
    journal.commit({
      agentId: "main",
      sessionKey: "dialog-1",
      initialState: { cursor: 0 },
      finalState: { cursor: i + 1 },
      batches: [batch(`batch-${i}-${"x".repeat(4096)}`)],
    });
  }

  const path = join(
    root,
    "sessions",
    durableAgentKey("main"),
    `${digest("dialog-1")}.json`,
  );
  assert.ok(statSync(path).size < 2_000, "session checkpoint contains state, not queued bodies");
  assert.ok(journal.queue.approximateDepth("main") >= 50);
});

test("different agents and sessions cannot alias journal paths", (t) => {
  const { journal } = withJournal(t);
  journal.commit({
    agentId: "main",
    sessionKey: "same",
    initialState: {},
    finalState: { owner: "main" },
    batches: [],
  });
  journal.commit({
    agentId: "igor",
    sessionKey: "same",
    initialState: {},
    finalState: { owner: "igor" },
    batches: [],
  });
  journal.commit({
    agentId: "main",
    sessionKey: "../../same",
    initialState: {},
    finalState: { owner: "other-session" },
    batches: [],
  });

  assert.equal(journal.read("main", "same")?.committed.owner, "main");
  assert.equal(journal.read("igor", "same")?.committed.owner, "igor");
  assert.equal(journal.read("main", "../../same")?.committed.owner, "other-session");
});
