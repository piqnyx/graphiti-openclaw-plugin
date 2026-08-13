import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, parseConfig } from "../dist/config.js";

test("diagnostic defaults stay non-content and info-level", () => {
  const cfg = parseConfig({});
  assert.equal(cfg.logLevel, "info");
  assert.equal(cfg.logContent, false);
  assert.equal(cfg.logOperations, true);
  assert.deepEqual(cfg, DEFAULT_CONFIG);
});

test("live diagnostic overrides are accepted", () => {
  const cfg = parseConfig({ captureBatchTurns: 1, logLevel: "debug", logContent: true });
  assert.equal(cfg.captureBatchTurns, 1);
  assert.equal(cfg.logLevel, "debug");
  assert.equal(cfg.logContent, true);
});

test("invalid diagnostic values fail closed", () => {
  assert.throws(() => parseConfig({ logLevel: "trace" }), /logLevel/);
  assert.throws(() => parseConfig({ logContent: "yes" }), /logContent/);
  assert.throws(() => parseConfig({ oldOption: true }), /unknown plugin config key/);
});
