import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSessionPatterns, matchesSessionPattern } from "../dist/session-filter.js";
import { parseConfig } from "../dist/config.js";
import { register } from "../dist/index.js";

const stateRoot = mkdtempSync(join(tmpdir(), "graphiti-exclusion-"));
process.on("exit", () => rmSync(stateRoot, { recursive: true, force: true }));

let instance = 0;
function makeRuntime(pluginConfig) {
  process.env.OPENCLAW_STATE_DIR = join(stateRoot, `api-${instance++}`);
  const hooks = new Map();
  const logs = [];
  register({
    pluginConfig,
    logger: {
      debug: (message) => logs.push(message),
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
    on: (name, handler) => hooks.set(name, handler),
  });
  return { hooks, logs };
}

const baseConfig = (overrides = {}) => ({
  bufferLimit: 4,
  bufferTimeout: 30,
  logLevel: "debug",
  agents: { main: { user: "Вит", assistant: "Краб" } },
  ...overrides,
});

test("glob patterns match within and across session key segments", () => {
  const patterns = compileSessionPatterns([
    "agent:*:dreaming-**",
    "agent:*:cron:**",
    "**:slug-generator",
  ]);

  assert.ok(matchesSessionPattern("agent:main:dreaming-narrative-memory-core-v2-rem-f00c", patterns));
  assert.ok(matchesSessionPattern("agent:igor:cron:nightly:42", patterns));
  assert.ok(matchesSessionPattern("agent:main:web:slug-generator", patterns));

  assert.equal(matchesSessionPattern("agent:main:telegram:12345", patterns), undefined);
  assert.equal(matchesSessionPattern("agent:main:web:conversation-a", patterns), undefined);
  assert.equal(
    matchesSessionPattern("agent:main:web:dreaming-lookalike", patterns),
    undefined,
    "a single * must not cross a segment boundary",
  );
  assert.equal(matchesSessionPattern(undefined, patterns), undefined);
  assert.equal(matchesSessionPattern("agent:main:web:x", []), undefined);
});

test("pattern metacharacters in a session key are matched literally", () => {
  const patterns = compileSessionPatterns(["agent:main:web:a.b+c"]);
  assert.ok(matchesSessionPattern("agent:main:web:a.b+c", patterns));
  assert.equal(matchesSessionPattern("agent:main:web:axbxc", patterns), undefined);
});

test("excludeSessionPatterns is validated and defaults to empty", () => {
  assert.deepEqual(parseConfig({}).excludeSessionPatterns, []);
  assert.deepEqual(
    parseConfig({ excludeSessionPatterns: ["agent:*:dreaming-**"] }).excludeSessionPatterns,
    ["agent:*:dreaming-**"],
  );
  assert.throws(() => parseConfig({ excludeSessionPatterns: "agent:*" }), /must be an array/);
  assert.throws(() => parseConfig({ excludeSessionPatterns: [""] }), /non-empty string/);
  assert.throws(() => parseConfig({ excludeSessionPatterns: [42] }), /non-empty string/);
});

test("an excluded session is skipped by capture and by recall", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    throw new Error("an excluded session must never reach Graphiti");
  };

  try {
    const { hooks, logs } = makeRuntime(
      baseConfig({ excludeSessionPatterns: ["agent:*:dreaming-**"] }),
    );
    const ctx = {
      agentId: "main",
      sessionKey: "agent:main:dreaming-narrative-memory-core-v2-rem-f00ca3560c6a",
      trigger: "user",
    };

    hooks.get("agent_end")(
      {
        success: true,
        messages: [
          { role: "user", content: "dreaming input" },
          { role: "assistant", content: "dreaming output" },
        ],
      },
      ctx,
    );
    const recall = await hooks.get("before_prompt_build")({ prompt: "что я помню?", messages: [] }, ctx);

    assert.equal(recall, undefined, "no context is injected into an excluded session");
    assert.deepEqual(calls, [], "no MCP traffic at all for an excluded session");
    assert.ok(logs.some((line) => line.includes("event=capture_skipped") && line.includes('reason="excluded_session"')));
    assert.ok(logs.some((line) => line.includes("event=recall_skipped") && line.includes('reason="excluded_session"')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("background runs never receive recall either", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("a background run must never reach Graphiti");
  };

  try {
    const { hooks, logs } = makeRuntime(baseConfig());
    const result = await hooks.get("before_prompt_build")(
      { prompt: "heartbeat prompt", messages: [] },
      { agentId: "main", sessionKey: "agent:main:heartbeat:1", trigger: "heartbeat" },
    );

    assert.equal(result, undefined);
    assert.ok(logs.some((line) => line.includes("event=recall_skipped") && line.includes('reason="background_run"')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
