import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, MIN_BUFFER_TIMEOUT_SEC, parseConfig } from "../dist/config.js";

test("capture defaults: buffer fields and per-agent canonical actors", () => {
  const cfg = parseConfig({});
  assert.equal(cfg.bufferLimit, 4);
  assert.equal(cfg.bufferTimeout, 900);
  assert.deepEqual(cfg.agents, {
    main: { user: "Вит", assistant: "Краб" },
  });
  assert.deepEqual(cfg, DEFAULT_CONFIG);
});

test("diagnostic defaults stay non-content and info-level", () => {
  const cfg = parseConfig({});
  assert.equal(cfg.logLevel, "info");
  assert.equal(cfg.logContent, false);
  assert.equal(cfg.logOperations, true);
});

test("explicit debug content diagnostics are accepted", () => {
  const cfg = parseConfig({ logLevel: "debug", logContent: true });
  assert.equal(cfg.logLevel, "debug");
  assert.equal(cfg.logContent, true);
});

test("bufferLimit must be even and >= 4", () => {
  assert.throws(() => parseConfig({ bufferLimit: 3 }), /bufferLimit/);
  assert.throws(() => parseConfig({ bufferLimit: 5 }), /bufferLimit must be even/);
  assert.doesNotThrow(() => parseConfig({ bufferLimit: 4 }));
  assert.doesNotThrow(() => parseConfig({ bufferLimit: 1000 }));
});

test("bufferTimeout minimum equals the internal 30-second ticker floor", () => {
  assert.equal(MIN_BUFFER_TIMEOUT_SEC, 30);
  assert.throws(() => parseConfig({ bufferTimeout: 29 }), /bufferTimeout/);
  assert.doesNotThrow(() => parseConfig({ bufferTimeout: 30 }));
});

test("agents: each entry needs non-empty user and assistant names", () => {
  assert.throws(() => parseConfig({ agents: { main: {} } }), /user/);
  assert.throws(
    () => parseConfig({ agents: { main: { user: "Вит" } } }),
    /assistant/,
  );
  assert.throws(
    () => parseConfig({ agents: { main: { user: "", assistant: "Краб" } } }),
    /user/,
  );
  assert.throws(
    () => parseConfig({ agents: { "": { user: "Вит", assistant: "Краб" } } }),
    /agentId/,
  );
  assert.doesNotThrow(() =>
    parseConfig({
      agents: {
        main: { user: "Вит", assistant: "Краб" },
        igor: { user: "Игорь", assistant: "Ассистент" },
      },
    }),
  );
});

test("agents replaces obsolete participants; aliases are gone", () => {
  assert.throws(
    () => parseConfig({ participants: [{ role: "user", name: "Вит" }] }),
    /unknown plugin config key/,
  );
  assert.throws(
    () => parseConfig({ agents: { main: { user: "Вит", assistant: "Краб", aliases: [] } } }),
    /aliases/,
  );
});

test("customExtractionInstructions is not a config key because the prompt is internal", () => {
  assert.throws(
    () => parseConfig({ customExtractionInstructions: "Extract ALL entities." }),
    /unknown plugin config key/,
  );
});

test("obsolete v0.1 buffer flags are rejected", () => {
  assert.throws(() => parseConfig({ captureBatchTurns: 1 }), /unknown plugin config key/);
  assert.throws(
    () => parseConfig({ captureBatchIdleFlushSeconds: 1 }),
    /unknown plugin config key/,
  );
  assert.throws(() => parseConfig({ captureMaxChars: 1000 }), /unknown plugin config key/);
});

test("unknown keys still fail closed", () => {
  assert.throws(() => parseConfig({ oldOption: true }), /unknown plugin config key/);
});
