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

test("a batch that never lands is reported rather than retried forever", () => {
  const tracker = new PendingConfirmationTracker({ graceMs: 0, maxAttempts: 2 });
  tracker.track(batch("doomed"));
  tracker.track(batch("doomed"));
  tracker.track(batch("doomed"));

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.due.length, 0);
  assert.equal(snapshot.stuck.length, 1);
  assert.equal(snapshot.stuck[0].attempts, 2);
});

test("the tracker is bounded, and says how much it dropped", () => {
  const tracker = new PendingConfirmationTracker({ maxTracked: 2 });
  const now = Date.now();
  tracker.track(batch("a", { submittedAt: now - 3_000 }));
  tracker.track(batch("b", { submittedAt: now - 2_000 }));
  tracker.track(batch("c", { submittedAt: now - 1_000 }));

  // An outage must cost a bounded amount of disk. What was given up is counted,
  // not hidden: the status tool reports it.
  assert.deepEqual(tracker.outstandingUuids().sort(), ["b", "c"]);
  assert.equal(tracker.snapshot().dropped, 1);
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
