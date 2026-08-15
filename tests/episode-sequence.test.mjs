import test from "node:test";
import assert from "node:assert/strict";
import { EpisodeSequenceTracker, episodeNamePrefix } from "../dist/episode-sequence.js";

test("first batch has no predecessor and second batch chains to accepted UUID", () => {
  const tracker = new EpisodeSequenceTracker();
  const saga = "1d8d5bfd-de0e-4877-82cb-6bc2a77c6957";

  const first = tracker.prepare("main", saga);
  assert.deepEqual(first, {
    batchNumber: 1,
    name: "6bc2a77c6957-1",
    previousEpisodeUuids: [],
    sagaPreviousEpisodeUuid: undefined,
  });

  tracker.accept("main", saga, first.batchNumber, "uuid-1");
  const second = tracker.prepare("main", saga);
  assert.deepEqual(second, {
    batchNumber: 2,
    name: "6bc2a77c6957-2",
    previousEpisodeUuids: ["uuid-1"],
    sagaPreviousEpisodeUuid: "uuid-1",
  });
});

test("interleaved sessions of one agent never borrow each other's predecessor", () => {
  const tracker = new EpisodeSequenceTracker();

  const a1 = tracker.prepare("main", "session:a");
  tracker.accept("main", "session:a", a1.batchNumber, "a-uuid-1");

  const b1 = tracker.prepare("main", "session:b");
  assert.deepEqual(b1.previousEpisodeUuids, []);
  tracker.accept("main", "session:b", b1.batchNumber, "b-uuid-1");

  const a2 = tracker.prepare("main", "session:a");
  assert.deepEqual(a2.previousEpisodeUuids, ["a-uuid-1"]);
  assert.equal(a2.sagaPreviousEpisodeUuid, "a-uuid-1");
  assert.equal(a2.batchNumber, 2);
});

test("same sessionKey under different agents is isolated", () => {
  const tracker = new EpisodeSequenceTracker();
  const main1 = tracker.prepare("main", "same-session");
  tracker.accept("main", "same-session", main1.batchNumber, "main-uuid");

  const igor1 = tracker.prepare("igor", "same-session");
  assert.equal(igor1.batchNumber, 1);
  assert.deepEqual(igor1.previousEpisodeUuids, []);
});

test("prepare does not advance state until MCP acceptance", () => {
  const tracker = new EpisodeSequenceTracker();
  const firstAttempt = tracker.prepare("main", "s1");
  const retryAttempt = tracker.prepare("main", "s1");
  assert.deepEqual(retryAttempt, firstAttempt);
  assert.deepEqual(tracker.snapshot("main", "s1"), { acceptedBatches: 0 });
});

test("accept rejects out-of-order updates", () => {
  const tracker = new EpisodeSequenceTracker();
  assert.throws(() => tracker.accept("main", "s1", 2, "uuid"), /out of order/);
});

test("episodeNamePrefix uses UUID tail and has a safe fallback", () => {
  assert.equal(
    episodeNamePrefix("agent:main:1d8d5bfd-de0e-4877-82cb-6bc2a77c6957"),
    "6bc2a77c6957",
  );
  assert.equal(episodeNamePrefix("agent:main:telegram chat"), "telegram-chat");
});
