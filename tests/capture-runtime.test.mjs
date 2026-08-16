import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "../dist/index.js";
import { resetCaptureRuntimeForTests } from "../dist/capture-runtime.js";

const stateRoot = mkdtempSync(join(tmpdir(), "graphiti-runtime-share-"));
process.on("exit", () => rmSync(stateRoot, { recursive: true, force: true }));

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function installFetch(t) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    if (payload.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18" } });
    }
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
    calls.push(payload.params);
    const { name, arguments: args } = payload.params;
    if (name === "get_saga") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: { structuredContent: { result: { error: `No saga named '${args.saga_name}' found in group '${args.group_id}'` } } },
      });
    }
    if (name === "get_queue_status") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: { structuredContent: { result: { group_id: args.group_id, blocked: false, attempts: 0, pending: 0 } } },
      });
    }
    if (name === "add_memory") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: { structuredContent: { result: { message: "queued", uuid: args.uuid } } },
      });
    }
    throw new Error(`unexpected tool ${name}`);
  };
  return calls;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  assert.fail("condition was not met before timeout");
}

const config = (overrides = {}) => ({
  autoRecall: false,
  bufferLimit: 4,
  bufferTimeout: 30,
  logLevel: "debug",
  agents: { main: { user: "Вит", assistant: "Краб" } },
  ...overrides,
});

function registerRuntime(stateDir, overrides) {
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const hooks = new Map();
  const logs = [];
  register({
    pluginConfig: config(overrides),
    logger: {
      debug: (m) => logs.push(m),
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
    },
    on: (name, handler) => hooks.set(name, handler),
  });
  return { hooks, logs };
}

const ctx = { agentId: "main", sessionKey: "agent:main:web:1d8d5bfd-de0e-4877-82cb-6bc2a77c6957", trigger: "user" };
const turn = (n) => ({
  success: true,
  messages: [
    { role: "user", content: `user-${n}` },
    { role: "assistant", content: `assistant-${n}` },
  ],
});

test("repeated registrations in one process share one capture pipeline", async (t) => {
  resetCaptureRuntimeForTests();
  const calls = installFetch(t);
  const dir = join(stateRoot, "shared");

  // OpenClaw registers the plugin once per host surface.
  const first = registerRuntime(dir);
  const second = registerRuntime(dir);
  const third = registerRuntime(dir);

  assert.equal(second.logs.filter((l) => l.includes("event=capture_pipeline")).length, 0,
    "a reused pipeline is not announced as new");

  // Two messages through one surface, two through another: one buffer, one batch.
  first.hooks.get("agent_end")(turn(1), ctx);
  third.hooks.get("agent_end")(
    { success: true, messages: [...turn(1).messages, ...turn(2).messages] },
    ctx,
  );

  await waitFor(() => calls.some((c) => c.name === "add_memory"));
  const adds = calls.filter((c) => c.name === "add_memory");
  assert.equal(adds.length, 1, "one batch must produce exactly one episode");
  assert.equal(adds[0].arguments.name.endsWith("-1"), true);

  await second.hooks.get("gateway_stop")();
});

test("a restart with unsent messages flushes the restored buffer exactly once", async (t) => {
  resetCaptureRuntimeForTests();
  const dir = join(stateRoot, "restore-once");
  const firstCalls = installFetch(t);

  // Leave two messages unsent, then stop.
  const before = registerRuntime(dir, { bufferLimit: 6 });
  before.hooks.get("agent_end")(turn(1), ctx);
  await before.hooks.get("gateway_stop")();
  assert.equal(firstCalls.filter((c) => c.name === "add_memory").length, 0);

  // New process: several registrations, and the restored buffer is already idle,
  // so every engine that owned it would flush it on resume.
  resetCaptureRuntimeForTests();
  const calls = installFetch(t);
  const restored = [
    registerRuntime(dir, { bufferLimit: 6, bufferTimeout: 30 }),
    registerRuntime(dir, { bufferLimit: 6, bufferTimeout: 30 }),
    registerRuntime(dir, { bufferLimit: 6, bufferTimeout: 30 }),
  ];
  assert.equal(
    restored.filter((r) => r.logs.some((l) => l.includes("event=capture_spool_restored"))).length,
    1,
    "the spool is read by one pipeline, not by every registration",
  );

  restored[0].hooks.get("agent_end")(
    { success: true, messages: [...turn(1).messages, ...turn(2).messages, ...turn(3).messages] },
    ctx,
  );
  await waitFor(() => calls.some((c) => c.name === "add_memory"));
  await sleep(120);

  const adds = calls.filter((c) => c.name === "add_memory");
  assert.equal(adds.length, 1, "the restored batch must reach Graphiti once, under one uuid");
  assert.equal(adds[0].arguments.name.endsWith("-1"), true);
  await restored[0].hooks.get("gateway_stop")();
});

test("a stopped pipeline is replaced rather than reused", async (t) => {
  resetCaptureRuntimeForTests();
  installFetch(t);
  const dir = join(stateRoot, "revive");

  const first = registerRuntime(dir);
  await first.hooks.get("gateway_stop")();

  // A hot reload after the host stopped the previous surface must not inherit a
  // dead engine: capture would silently stop working.
  const second = registerRuntime(dir);
  assert.ok(second.logs.some((l) => l.includes('event=capture_pipeline outcome="replaced_stopped"')));

  second.hooks.get("agent_end")(turn(1), ctx);
  assert.ok(
    !second.logs.some((l) => l.includes("engine_rejected_messages")),
    "the fresh pipeline accepts capture",
  );
  await second.hooks.get("gateway_stop")();
});

test("a different configuration gets its own pipeline", (t) => {
  resetCaptureRuntimeForTests();
  installFetch(t);
  const dir = join(stateRoot, "reconfigured");

  registerRuntime(dir, { bufferLimit: 4 });
  const changed = registerRuntime(dir, { bufferLimit: 9 });
  assert.ok(changed.logs.some((l) => l.includes('outcome="replaced_reconfigured"')));
});

test("one spool holds several agents without their data ever meeting", async (t) => {
  resetCaptureRuntimeForTests();
  const dir = join(stateRoot, "multi-agent");
  const before = installFetch(t);

  // Two agents talk through the same process; neither is flushed yet.
  const gateway = registerRuntime(dir, { bufferLimit: 6 });
  gateway.hooks.get("agent_end")(
    { success: true, messages: [{ role: "user", content: "секрет вита" }] },
    { agentId: "main", sessionKey: "agent:main:telegram:1", trigger: "user" },
  );
  gateway.hooks.get("agent_end")(
    { success: true, messages: [{ role: "user", content: "секрет игоря" }] },
    { agentId: "igor", sessionKey: "agent:igor:telegram:2", trigger: "user" },
  );
  await gateway.hooks.get("gateway_stop")();
  assert.deepEqual(before.filter((c) => c.name === "add_memory"), []);

  // Restart: both survive, and each one flushes into its own group only.
  resetCaptureRuntimeForTests();
  const calls = installFetch(t);
  const after = registerRuntime(dir, { bufferLimit: 2, bufferTimeout: 30 });
  after.hooks.get("agent_end")(
    { success: true, messages: [{ role: "user", content: "секрет вита" }, { role: "assistant", content: "ответ виту" }] },
    { agentId: "main", sessionKey: "agent:main:telegram:1", trigger: "user" },
  );
  await waitFor(() => calls.some((c) => c.name === "add_memory"));

  const adds = calls.filter((c) => c.name === "add_memory").map((c) => c.arguments);
  assert.equal(adds.length, 1, "only the agent that reached its limit is submitted");
  assert.equal(adds[0].group_id, "main");
  assert.match(adds[0].episode_body, /секрет вита/);
  assert.doesNotMatch(adds[0].episode_body, /секрет игоря/, "another agent's buffer must never join this episode");
  await after.hooks.get("gateway_stop")();
});
