import test from "node:test";
import assert from "node:assert/strict";
import { EpisodeSequenceTracker, episodeNamePrefix } from "../dist/episode-sequence.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("first batch has no predecessor and second batch chains to accepted UUID", () => {
  const tracker = new EpisodeSequenceTracker();
  const saga = "1d8d5bfd-de0e-4877-82cb-6bc2a77c6957";

  const first = tracker.prepare("main", saga);
  assert.match(first.episodeUuid, UUID_RE);
  assert.equal(first.batchNumber, 1);
  assert.equal(first.name, "6bc2a77c6957-1");
  assert.deepEqual(first.previousEpisodeUuids, []);
  assert.equal(first.sagaPreviousEpisodeUuid, undefined);

  tracker.accept("main", saga, first.batchNumber, first.episodeUuid);
  const second = tracker.prepare("main", saga);
  assert.match(second.episodeUuid, UUID_RE);
  assert.notEqual(second.episodeUuid, first.episodeUuid);
  assert.equal(second.batchNumber, 2);
  assert.equal(second.name, "6bc2a77c6957-2");
  assert.deepEqual(second.previousEpisodeUuids, [first.episodeUuid]);
  assert.equal(second.sagaPreviousEpisodeUuid, first.episodeUuid);
});

test("interleaved sessions of one agent never borrow each other's predecessor", () => {
  const tracker = new EpisodeSequenceTracker();

  const a1 = tracker.prepare("main", "session:a");
  tracker.accept("main", "session:a", a1.batchNumber, a1.episodeUuid);

  const b1 = tracker.prepare("main", "session:b");
  assert.deepEqual(b1.previousEpisodeUuids, []);
  tracker.accept("main", "session:b", b1.batchNumber, b1.episodeUuid);

  const a2 = tracker.prepare("main", "session:a");
  assert.deepEqual(a2.previousEpisodeUuids, [a1.episodeUuid]);
  assert.equal(a2.sagaPreviousEpisodeUuid, a1.episodeUuid);
  assert.equal(a2.batchNumber, 2);
});

test("same sessionKey under different agents is isolated", () => {
  const tracker = new EpisodeSequenceTracker();
  const main1 = tracker.prepare("main", "same-session");
  tracker.accept("main", "same-session", main1.batchNumber, main1.episodeUuid);

  const igor1 = tracker.prepare("igor", "same-session");
  assert.equal(igor1.batchNumber, 1);
  assert.deepEqual(igor1.previousEpisodeUuids, []);
});

test("prepare reserves one UUID and reuses it until MCP acceptance", () => {
  const tracker = new EpisodeSequenceTracker();
  const firstAttempt = tracker.prepare("main", "s1");
  const retryAttempt = tracker.prepare("main", "s1");
  assert.deepEqual(retryAttempt, firstAttempt);
  const snapshot = tracker.snapshot("main", "s1");
  assert.equal(snapshot.acceptedBatches, 0);
  assert.equal(snapshot.lastEpisodeUuid, undefined);
  assert.equal(snapshot.pending.episodeUuid, firstAttempt.episodeUuid);
});

test("accept rejects a UUID different from the reserved caller UUID", () => {
  const tracker = new EpisodeSequenceTracker();
  const pending = tracker.prepare("main", "s1");
  assert.throws(
    () => tracker.accept("main", "s1", pending.batchNumber, "00000000-0000-4000-8000-000000000000"),
    /unexpected episode UUID/,
  );
});

test("accept rejects out-of-order updates", () => {
  const tracker = new EpisodeSequenceTracker();
  tracker.prepare("main", "s1");
  assert.throws(() => tracker.accept("main", "s1", 2, "uuid"), /out of order/);
});

test("hydrate restores persisted saga continuity after plugin restart", () => {
  const tracker = new EpisodeSequenceTracker();
  tracker.hydrate("main", "session:a", 6, "persisted-uuid-6");
  const next = tracker.prepare("main", "session:a");
  assert.equal(next.batchNumber, 7);
  assert.equal(next.name, "a-7");
  assert.deepEqual(next.previousEpisodeUuids, ["persisted-uuid-6"]);
  assert.equal(next.sagaPreviousEpisodeUuid, "persisted-uuid-6");
});

test("episodeNamePrefix uses UUID tail and has a safe fallback", () => {
  assert.equal(
    episodeNamePrefix("agent:main:1d8d5bfd-de0e-4877-82cb-6bc2a77c6957"),
    "6bc2a77c6957",
  );
  assert.equal(episodeNamePrefix("agent:main:telegram chat"), "telegram-chat");
});

test("a reserved identity is re-adopted only when the saga still expects it", () => {
  const tracker = new EpisodeSequenceTracker();
  tracker.hydrate("main", "s1", 3, "uuid-3");

  const reserved = {
    batchNumber: 4,
    episodeUuid: "reserved-uuid-4",
    name: "s1-4",
    previousEpisodeUuids: ["uuid-3"],
    sagaPreviousEpisodeUuid: "uuid-3",
  };
  assert.equal(tracker.adoptPending("main", "s1", reserved), true);
  assert.deepEqual(tracker.prepare("main", "s1"), reserved, "the replay reuses the reserved identity");

  const diverged = new EpisodeSequenceTracker();
  diverged.hydrate("main", "s1", 5, "uuid-5");
  assert.equal(
    diverged.adoptPending("main", "s1", reserved),
    false,
    "a saga that moved past the reserved batch must not reuse its number",
  );

  const otherPredecessor = new EpisodeSequenceTracker();
  otherPredecessor.hydrate("main", "s1", 3, "somebody-elses-uuid-3");
  assert.equal(
    otherPredecessor.adoptPending("main", "s1", reserved),
    false,
    "a different predecessor means the chain diverged",
  );
});
