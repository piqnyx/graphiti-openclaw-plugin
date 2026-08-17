import test from "node:test";
import assert from "node:assert/strict";

import { PendingConfirmationTracker, sequenceKey } from "../dist/pending-confirmation.js";

const batch = (uuid, over = {}) => ({
  agentId: "main",
  sessionKey: "agent:main:telegram:1",
  uuid,
  name: `8248439450-${over.batchNumber ?? 1}`,
  batchNumber: over.batchNumber ?? 1,
  episodeBody: '{"messages":[]}',
  previousEpisodeUuids: [],
  referenceTime: "2026-08-17T10:00:00.000Z",
  ...over,
});

test("a batch stays outstanding until its episode is seen in the graph", () => {
  const tracker = new PendingConfirmationTracker();
  tracker.track(batch("u-1"));

  assert.deepEqual(tracker.outstandingUuids(), ["u-1"]);
  assert.equal(tracker.snapshot().outstanding, 1);

  assert.equal(tracker.confirm(["u-1"]), 1);
  assert.equal(tracker.snapshot().outstanding, 0);
  // Confirming something already forgotten is not an error: the check runs on a
  // timer and may race a confirmation from the previous pass.
  assert.equal(tracker.confirm(["u-1"]), 0);
});

test("only batches past the grace period are due for resubmission", () => {
  const tracker = new PendingConfirmationTracker({ graceMs: 60_000 });
  const now = Date.now();
  tracker.track(batch("fresh", { submittedAt: now - 5_000 }));
  tracker.track(batch("ripe", { submittedAt: now - 120_000, batchNumber: 2 }));

  const due = tracker.snapshot(now).due.map((entry) => entry.uuid);
  // Extraction takes tens of seconds; resubmitting work still in progress would
  // load the backend precisely when it is already struggling.
  assert.deepEqual(due, ["ripe"]);
});

test("a batch that keeps failing is reported but never abandoned", () => {
  const tracker = new PendingConfirmationTracker({ graceMs: 1, attentionAfterAttempts: 2 });
  tracker.track(batch("doomed", { submittedAt: 0 }));
  tracker.track(batch("doomed", { submittedAt: 0 }));
  tracker.track(batch("doomed", { submittedAt: 0 }));

  const snapshot = tracker.snapshot();
  // The failure this guards against is a model that comes back in hours. Giving
  // up on it would throw away exactly what waiting would have saved.
  assert.equal(snapshot.due.length, 1, "it must still be due for another attempt");
  assert.equal(snapshot.needsAttention.length, 1, "and the user must be able to hear about it");
  assert.equal(snapshot.needsAttention[0].attempts, 2);
});

test("the wait doubles with each failure and stops at the ceiling", () => {
  const tracker = new PendingConfirmationTracker({ graceMs: 30_000, maxBackoffMs: 3_600_000 });

  assert.equal(tracker.backoffFor(0), 30_000);
  assert.equal(tracker.backoffFor(1), 60_000);
  assert.equal(tracker.backoffFor(2), 120_000);
  // Retrying every thirty seconds through a rate limit keeps the quota pinned;
  // waiting a day after one would ignore a backend that has already returned.
  assert.equal(tracker.backoffFor(20), 3_600_000);
});

test("a batch waits out its own backoff before being resent", () => {
  const tracker = new PendingConfirmationTracker({ graceMs: 30_000 });
  const now = Date.now();
  tracker.track(batch("first-try", { uuid: "first-try", submittedAt: now - 40_000, attempts: 0 }));
  tracker.track(batch("third-try", { uuid: "third-try", submittedAt: now - 40_000, attempts: 3 }));

  const due = tracker.snapshot(now).due.map((entry) => entry.uuid);
  assert.deepEqual(due, ["first-try"], "a batch retried three times waits four minutes, not thirty seconds");
});

test("the ledger is bounded by size, and says how much it had to drop", () => {
  // Fifty gigabytes in practice; a tiny bound here to reach it in three batches.
  const tracker = new PendingConfirmationTracker({ maxBytes: 40 });
  const now = Date.now();
  const body = { episodeBody: "x".repeat(20) };
  tracker.track(batch("a", { uuid: "a", submittedAt: now - 3_000, ...body }));
  tracker.track(batch("b", { uuid: "b", submittedAt: now - 2_000, ...body }));
  tracker.track(batch("c", { uuid: "c", submittedAt: now - 1_000, ...body }));

  // Nothing is given up while there is room, however long the backend is down.
  // Past the bound the oldest go first, and what was lost is counted, not hidden.
  assert.deepEqual(tracker.outstandingUuids().sort(), ["b", "c"]);
  assert.equal(tracker.snapshot().dropped, 1);
  assert.equal(tracker.snapshot().bytes, 40);
});

test("the highest issued number per session survives a restart", () => {
  const tracker = new PendingConfirmationTracker();
  tracker.track(batch("u-22", { batchNumber: 22 }));
  tracker.track(batch("u-23", { batchNumber: 23 }));
  tracker.track(batch("other", { sessionKey: "agent:main:web:9", batchNumber: 4 }));

  const restored = new PendingConfirmationTracker();
  restored.restore(tracker.export());

  // The backend's episode count lags acceptance, and a lagging count hands the
  // same number out twice — which is how one dialog got two episodes named -22.
  const highest = restored.highestIssued();
  assert.equal(highest.get(sequenceKey("main", "agent:main:telegram:1")), 23);
  assert.equal(highest.get(sequenceKey("main", "agent:main:web:9")), 4);
});
