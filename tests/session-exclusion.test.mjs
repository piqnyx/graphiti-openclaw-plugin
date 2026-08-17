import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSessionPatterns, matchSessionExclusion } from "../dist/session-filter.js";
import { DEFAULT_CONFIG } from "../dist/config.js";
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

test("patterns are regular expressions tested against the session key", () => {
  const patterns = compileSessionPatterns(["^agent:[^:]+:dreaming-", ":cron:"]);

  assert.deepEqual(
    matchSessionExclusion({ sessionKey: "agent:main:dreaming-narrative-core-f00c" }, patterns),
    { pattern: "^agent:[^:]+:dreaming-", matched: "sessionKey" },
  );
  assert.equal(
    matchSessionExclusion({ sessionKey: "agent:igor:cron:nightly:42" }, patterns).matched,
    "sessionKey",
  );
  assert.equal(matchSessionExclusion({ sessionKey: "agent:main:telegram:12345" }, patterns), undefined);
  assert.equal(matchSessionExclusion({}, patterns), undefined);
  assert.equal(matchSessionExclusion({ sessionKey: "agent:main:web:x" }, []), undefined);
});

test("the same list also excludes by run trigger", () => {
  const patterns = compileSessionPatterns(["^heartbeat$"]);

  assert.deepEqual(
    matchSessionExclusion({ sessionKey: "agent:main:web:plain-key", trigger: "heartbeat" }, patterns),
    { pattern: "^heartbeat$", matched: "trigger" },
  );
  assert.equal(
    matchSessionExclusion({ sessionKey: "agent:main:web:plain-key", trigger: "user" }, patterns),
    undefined,
  );
});

test("stateful regex flags cannot desynchronise repeated matching", () => {
  const patterns = compileSessionPatterns([":cron:"]);
  for (let i = 0; i < 5; i += 1) {
    assert.ok(matchSessionExclusion({ sessionKey: "agent:main:cron:job" }, patterns), `attempt ${i}`);
  }
});

test("excludeSessionPatterns defaults reproduce the old hardcoded filtering", () => {
  const patterns = compileSessionPatterns(parseConfig({}).excludeSessionPatterns);

  for (const sessionKey of [
    "agent:main:cron:nightly",
    "agent:main:heartbeat:1",
    "agent:main:subagent:worker",
    "***",
  ]) {
    assert.ok(matchSessionExclusion({ sessionKey }, patterns), sessionKey);
  }
  for (const trigger of ["cron", "heartbeat"]) {
    assert.ok(matchSessionExclusion({ sessionKey: "agent:main:web:x", trigger }, patterns), trigger);
  }

  assert.equal(
    matchSessionExclusion({ sessionKey: "agent:main:telegram:42", trigger: "user" }, patterns),
    undefined,
    "a real dialog is never excluded by the defaults",
  );
});

test("excludeSessionPatterns is validated as regular expressions", () => {
  assert.deepEqual(
    parseConfig({ excludeSessionPatterns: ["^agent:[^:]+:dreaming-"] }).excludeSessionPatterns,
    ["^agent:[^:]+:dreaming-"],
  );
  assert.deepEqual(parseConfig({ excludeSessionPatterns: [] }).excludeSessionPatterns, []);
  assert.throws(() => parseConfig({ excludeSessionPatterns: "agent" }), /must be an array/);
  assert.throws(() => parseConfig({ excludeSessionPatterns: [""] }), /non-empty string/);
  assert.throws(() => parseConfig({ excludeSessionPatterns: [42] }), /non-empty string/);
  assert.throws(
    () => parseConfig({ excludeSessionPatterns: ["agent:[main"] }),
    /not a valid regular expression/,
  );
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
      baseConfig({ excludeSessionPatterns: ["^agent:[^:]+:dreaming-"] }),
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

test("background runs never receive capture or recall by default", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("a background run must never reach Graphiti");
  };

  try {
    const { hooks, logs } = makeRuntime(baseConfig());
    const ctx = { agentId: "main", sessionKey: "agent:main:heartbeat:1", trigger: "heartbeat" };

    hooks.get("agent_end")({ success: true, messages: [{ role: "user", content: "tick" }] }, ctx);
    const result = await hooks.get("before_prompt_build")({ prompt: "heartbeat prompt", messages: [] }, ctx);

    assert.equal(result, undefined);
    assert.ok(logs.some((line) => line.includes("event=capture_skipped") && line.includes('reason="excluded_session"')));
    assert.ok(logs.some((line) => line.includes("event=recall_skipped") && line.includes('reason="excluded_session"')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("capturing for an agent missing from the config is reported once", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("offline");
  };

  try {
    const { hooks, logs } = makeRuntime(baseConfig());
    const ctx = { agentId: "purple", sessionKey: "agent:purple:web:1", trigger: "user" };

    hooks.get("agent_end")({ success: true, messages: [{ role: "user", content: "hi" }] }, ctx);
    hooks.get("agent_end")(
      { success: true, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }] },
      ctx,
    );

    const warnings = logs.filter((line) => line.includes("event=capture_agent_unconfigured"));
    assert.equal(warnings.length, 1, "reported once per agent, not per turn");
    assert.match(warnings[0], /agentId="purple"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the shipped defaults exclude OpenClaw's own setup probes", () => {
  const patterns = compileSessionPatterns(DEFAULT_CONFIG.excludeSessionPatterns);

  // Seen in a live graph: a model-setup probe wrote its own saga, because the
  // defaults only knew about cron, heartbeats and subagents.
  const probe = "agent:main:setup-inference:incognito-probe-setup-inference-044674ec-d610-49e5-816b-daf90ef954e7";
  assert.ok(matchSessionExclusion({ sessionKey: probe }, patterns), "a setup probe is not a conversation");

  // A real dialog is untouched by the new patterns.
  assert.equal(
    matchSessionExclusion({ sessionKey: "agent:main:telegram:direct:8248439450" }, patterns),
    undefined,
  );
});
