import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableQueueStore, durableAgentKey } from "../dist/durable-queue-store.js";

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function withStore(t) {
  const root = mkdtempSync(join(tmpdir(), "graphiti-durable-queue-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, store: new DurableQueueStore(root) };
}

function record(agentId, sequence, body) {
  return {
    version: 1,
    sequence,
    agentId,
    captureId: digest(`${agentId}:${body}`),
    enqueuedAt: 1234567890 + sequence,
    payload: { body },
  };
}

test("disk FIFO survives a new store instance and removes only its head", (t) => {
  const { root, store } = withStore(t);
  const one = store.allocateSequence("main");
  const two = store.allocateSequence("main");
  const three = store.allocateSequence("main");
  store.publish(record("main", one, "one"));
  store.publish(record("main", two, "two"));
  store.publish(record("main", three, "three"));

  const restarted = new DurableQueueStore(root);
  assert.equal(restarted.peekHead("main")?.payload.body, "one");
  assert.throws(() => restarted.removeHead("main", two), /refusing to remove non-head/);

  restarted.removeHead("main", one);
  assert.equal(restarted.peekHead("main")?.payload.body, "two");
  restarted.removeHead("main", two);
  assert.equal(restarted.peekHead("main")?.payload.body, "three");
  restarted.removeHead("main", three);
  assert.equal(restarted.peekHead("main"), undefined);
});

test("an allocation abandoned by a crash is a harmless sequence gap", (t) => {
  const { root, store } = withStore(t);
  const abandoned = store.allocateSequence("main");
  const published = store.allocateSequence("main");
  assert.equal(abandoned, 1);
  assert.equal(published, 2);
  store.publish(record("main", published, "survives"));

  const restarted = new DurableQueueStore(root);
  assert.equal(restarted.peekHead("main")?.sequence, 2);
  assert.equal(restarted.peekHead("main")?.payload.body, "survives");
});

test("publishing the same allocated record twice is idempotent but divergent reuse is fatal", (t) => {
  const { store } = withStore(t);
  const sequence = store.allocateSequence("main");
  const original = record("main", sequence, "same");
  store.publish(original);
  store.publish(original);

  assert.throws(
    () => store.publish({ ...original, payload: { body: "different" } }),
    /already contains different data/,
  );
});

test("head metadata may lag a durable unlink without replaying the removed record", (t) => {
  const { root, store } = withStore(t);
  const one = store.allocateSequence("main");
  const two = store.allocateSequence("main");
  store.publish(record("main", one, "one"));
  store.publish(record("main", two, "two"));
  store.removeHead("main", one);

  // A fresh process proves absence from disk and continues at the next published
  // sequence; this is the same state a crash after unlink but before metadata
  // advancement would leave.
  const restarted = new DurableQueueStore(root);
  assert.equal(restarted.peekHead("main")?.sequence, two);
});

test("updating a head may change delivery payload but never queue identity", (t) => {
  const { store } = withStore(t);
  const sequence = store.allocateSequence("main");
  store.publish(record("main", sequence, "body"));

  const updated = store.update("main", sequence, (current) => ({
    ...current,
    payload: { ...current.payload, episodeUuid: "remote-uuid" },
  }));
  assert.equal(updated.payload.episodeUuid, "remote-uuid");
  assert.equal(store.peekHead("main")?.payload.episodeUuid, "remote-uuid");

  assert.throws(
    () => store.update("main", sequence, (current) => ({ ...current, sequence: sequence + 1 })),
    /immutable identity/,
  );
});

test("agent IDs are physical queue boundaries, not filesystem paths", (t) => {
  const { store } = withStore(t);
  const weird = "../../main/../igor";
  const mainSequence = store.allocateSequence("main");
  const weirdSequence = store.allocateSequence(weird);
  store.publish(record("main", mainSequence, "main-only"));
  store.publish(record(weird, weirdSequence, "weird-only"));

  assert.notEqual(durableAgentKey("main"), durableAgentKey(weird));
  assert.equal(store.peekHead("main")?.payload.body, "main-only");
  assert.equal(store.peekHead(weird)?.payload.body, "weird-only");
  assert.deepEqual(store.listAgents(), [weird, "main"].sort());
});

test("a corrupt published head fails closed instead of being skipped", (t) => {
  const { root, store } = withStore(t);
  const sequence = store.allocateSequence("main");
  store.publish(record("main", sequence, "body"));

  const key = durableAgentKey("main");
  const segment = "000000000000";
  const file = `${String(sequence).padStart(20, "0")}.json`;
  writeFileSync(join(root, "agents", key, "queue", segment, file), "{broken json\n", "utf8");

  assert.throws(() => new DurableQueueStore(root).peekHead("main"), /JSON/);
});
