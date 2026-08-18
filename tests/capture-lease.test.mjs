import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureLease } from "../dist/capture-lease.js";

function tempSpool(t) {
  const dir = mkdtempSync(join(tmpdir(), "graphiti-capture-lease-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "capture-spool.json");
}

test("only one live process lease can own a spool", (t) => {
  const spool = tempSpool(t);
  const first = new CaptureLease(spool);
  const second = new CaptureLease(spool);

  first.acquire();
  t.after(() => {
    if (first.isHeld()) first.release();
    if (second.isHeld()) second.release();
  });

  assert.throws(() => second.acquire(), /already owned by live gateway pid/);
  first.release();
  assert.doesNotThrow(() => second.acquire());
  assert.equal(second.isHeld(), true);
});

test("dead-owner lease is quarantined and replaced", (t) => {
  const spool = tempSpool(t);
  const lock = `${spool}.lock`;
  const deadPid = 2_147_483_647;
  writeFileSync(
    lock,
    `${JSON.stringify({ version: 1, pid: deadPid, token: "dead", acquiredAt: 1 })}\n`,
    { mode: 0o600 },
  );

  const lease = new CaptureLease(spool);
  lease.acquire();
  t.after(() => {
    if (lease.isHeld()) lease.release();
  });

  const current = JSON.parse(readFileSync(lock, "utf8"));
  assert.equal(current.pid, process.pid);
  assert.notEqual(current.token, "dead");
});

test("malformed lease fails closed instead of stealing ownership", (t) => {
  const spool = tempSpool(t);
  writeFileSync(`${spool}.lock`, "not-json\n", { mode: 0o600 });
  const lease = new CaptureLease(spool);
  assert.throws(() => lease.acquire(), /malformed/);
  assert.equal(lease.isHeld(), false);
});
