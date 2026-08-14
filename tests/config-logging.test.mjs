import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, parseConfig } from "../dist/config.js";

test("v0.2 defaults: buffer fields and canonical participants", () => {
  const cfg = parseConfig({});
  assert.equal(cfg.bufferLimit, 4);
  assert.equal(cfg.bufferTimeout, 900);
  assert.deepEqual(cfg.participants, [
    { role: "user", name: "Вит", aliases: [] },
    { role: "assistant", name: "Краб", aliases: [] },
  ]);
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
  // дефолт 4 — валиден; max допускается
  assert.doesNotThrow(() => parseConfig({ bufferLimit: 1000 }));
});

test("bufferTimeout must be >= 120 seconds (2 min)", () => {
  assert.throws(() => parseConfig({ bufferTimeout: 119 }), /bufferTimeout/);
  assert.doesNotThrow(() => parseConfig({ bufferTimeout: 120 }));
});

test("participants require exactly one user and one assistant with names", () => {
  assert.throws(() => parseConfig({ participants: [] }), /user/);
  assert.throws(
    () => parseConfig({ participants: [{ role: "user", name: "Вит" }] }),
    /assistant/,
  );
  assert.throws(
    () =>
      parseConfig({
        participants: [
          { role: "user", name: "Вит" },
          { role: "user", name: "Другой" },
        ],
      }),
    /duplicate participant role/,
  );
  assert.throws(
    () =>
      parseConfig({
        participants: [
          { role: "user", name: "" },
          { role: "assistant", name: "Краб" },
        ],
      }),
    /user name/,
  );
  assert.doesNotThrow(() =>
    parseConfig({
      participants: [
        { role: "user", name: "Вит", aliases: ["Виктор", "В."] },
        { role: "assistant", name: "Краб", aliases: [] },
      ],
    }),
  );
});

test("aliases must be an array of non-empty strings", () => {
  assert.throws(
    () =>
      parseConfig({
        participants: [
          { role: "user", name: "Вит", aliases: "Виктор" },
          { role: "assistant", name: "Краб" },
        ],
      }),
    /alias/,
  );
  assert.throws(
    () =>
      parseConfig({
        participants: [
          { role: "user", name: "Вит", aliases: [""] },
          { role: "assistant", name: "Краб" },
        ],
      }),
    /alias/,
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
