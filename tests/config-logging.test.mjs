import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, parseConfig } from "../dist/config.js";

test("v0.2 defaults: buffer fields and per-agent canonical actors", () => {
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

test("live diagnostic overrides are accepted", () => {
  const cfg = parseConfig({ logLevel: "debug", logContent: true });
  assert.equal(cfg.logLevel, "debug");
  assert.equal(cfg.logContent, true);
});

test("bufferLimit must be >= 4", () => {
  assert.throws(() => parseConfig({ bufferLimit: 3 }), /bufferLimit/);
  assert.doesNotThrow(() => parseConfig({ bufferLimit: 4 }));
  assert.doesNotThrow(() => parseConfig({ bufferLimit: 1000 }));
});

test("bufferTimeout must be >= 120 seconds (2 min)", () => {
  assert.throws(() => parseConfig({ bufferTimeout: 119 }), /bufferTimeout/);
  assert.doesNotThrow(() => parseConfig({ bufferTimeout: 120 }));
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
  // Старая схема participants (даже корректная) не принимается.
  assert.throws(
    () => parseConfig({ participants: [{ role: "user", name: "Вит" }] }),
    /unknown plugin config key/,
  );
  // Ключ aliases больше не существует ни у кого — любой алиас упадёт как unknown.
  assert.throws(
    () => parseConfig({ agents: { main: { user: "Вит", assistant: "Краб", aliases: [] } } }),
    /aliases/,
  );
});

test("customExtractionInstructions defaults empty and accepts a string", () => {
  const cfg = parseConfig({});
  assert.equal(cfg.customExtractionInstructions, "");
  const withPrompt = parseConfig({ customExtractionInstructions: "Extract ALL entities." });
  assert.equal(withPrompt.customExtractionInstructions, "Extract ALL entities.");
  assert.throws(() => parseConfig({ customExtractionInstructions: 42 }), /customExtractionInstructions/);
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
