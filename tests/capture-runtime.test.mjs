import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "../dist/index.js";
import { resetCaptureRuntimeForTests } from "../dist/capture-runtime.js";
import { makeAgentStore } from "./helpers-agent-store.mjs";
const agentStore = makeAgentStore();

// The gateway writes its transcript and then fires the hook; capture reads the
// store, not the hook payload. Tests still describe a turn as a message list, so
// the fixture writes it first and the hook only says "a turn ended".
const agentEnd = (runtime, event, context) => {
  agentStore.deliver(context?.agentId ?? "main", context?.sessionKey ?? "", event?.messages ?? []);
  return runtime.hooks.get("agent_end")(event, context);
};

const stateRoot = mkdtempSync(join(tmpdir(), "graphiti-runtime-share-"));
process.on("exit", () => rmSync(stateRoot, { recursive: true, force: true }));

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(t) {
  const calls = [];
  const sagas = new Map();
  const episodes = new Map();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const sagaResult = (saga) => ({
    ...saga,
    chain_count: saga.episode_count,
    integrity_ok: true,
    integrity_errors: [],
  });

  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    if (payload.method === "initialize") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: { protocolVersion: "2025-06-18" },
      });
    }
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });

    calls.push(payload.params);
    const { name, arguments: args } = payload.params;
    let result;

    if (name === "get_saga") {
      const saga = sagas.get(`${args.group_id}\0${args.saga_name}`);
      result = saga
        ? sagaResult(saga)
        : { error: `No saga named '${args.saga_name}' found in group '${args.group_id}'` };
    } else if (name === "get_queue_status") {
      result = {
        group_id: args.group_id,
        blocked: false,
        attempts: 0,
        pending: 0,
        worker_running: true,
        queued_episode_uuids: [],
      };
    } else if (name === "add_memory") {
      episodes.set(args.uuid, { uuid: args.uuid, name: args.name, content: args.episode_body });
      if (args.saga) {
        const key = `${args.group_id}\0${args.saga}`;
        const previous = sagas.get(key);
        const alreadyTail = previous?.last_episode_uuid === args.uuid;
        sagas.set(key, {
          uuid: previous?.uuid ?? `saga-${args.saga}`,
          name: args.saga,
          group_id: args.group_id,
          summary: "",
          first_episode_uuid: previous?.first_episode_uuid ?? args.uuid,
          last_episode_uuid: args.uuid,
          episode_count: (previous?.episode_count ?? 0) + (alreadyTail ? 0 : 1),
        });
      }
      result = { message: "queued", uuid: args.uuid };
    } else if (name === "get_episodes_by_ref") {
      result = {
        episodes: (args.uuids ?? []).map((uuid) => episodes.get(uuid)).filter(Boolean),
      };
    } else {
      throw new Error(`unexpected tool ${name}`);
    }

    return jsonResponse({
      jsonrpc: "2.0",
      id: payload.id,
      result: { structuredContent: { result }, content: [], isError: false },
    });
  };
  return calls;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 2500) {
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
  agentDbPath: agentStore.agentDbPath,
  agents: {
    main: { user: "Вит", assistant: "Краб" },
    igor: { user: "Игорь", assistant: "Краб" },
  },
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

const ctx = {
  agentId: "main",
  sessionKey: "agent:main:web:1d8d5bfd-de0e-4877-82cb-6bc2a77c6957",
  trigger: "user",
};
const turn = (n) => ({
  success: true,
  messages: [
    { role: "user", content: `user-${n}` },
    { role: "assistant", content: `assistant-${n}` },
  ],
});

test("repeated registrations in one process share one capture pipeline", async (t) => {
  resetCaptureRuntimeForTests();
  t.after(resetCaptureRuntimeForTests);
  const calls = installFetch(t);
  const dir = join(stateRoot, "shared");

  const first = registerRuntime(dir);
  const second = registerRuntime(dir);
  const third = registerRuntime(dir);

  assert.equal(second.logs.filter((l) => l.includes("event=capture_pipeline")).length, 0);
  assert.equal(third.logs.filter((l) => l.includes("event=capture_pipeline")).length, 0);

  agentEnd(first, turn(1), ctx);
  agentEnd(third, 
    { success: true, messages: [...turn(1).messages, ...turn(2).messages] },
    ctx,
  );

  await waitFor(() => calls.some((c) => c.name === "add_memory"));
  const adds = calls.filter((c) => c.name === "add_memory");
  assert.equal(adds.length, 1, "one batch must produce exactly one episode");
  assert.equal(adds[0].arguments.name.endsWith("-1"), true);
  await second.hooks.get("gateway_stop")();
});

test("a restart with a partial buffer flushes it exactly once after continuation", async (t) => {
  resetCaptureRuntimeForTests();
  t.after(resetCaptureRuntimeForTests);
  const dir = join(stateRoot, "restore-once");
  const firstCalls = installFetch(t);

  const before = registerRuntime(dir, { bufferLimit: 6 });
  agentEnd(before, turn(1), ctx);
  await before.hooks.get("gateway_stop")();
  assert.equal(firstCalls.filter((c) => c.name === "add_memory").length, 0);

  resetCaptureRuntimeForTests();
  const calls = installFetch(t);
  const restored = [
    registerRuntime(dir, { bufferLimit: 6 }),
    registerRuntime(dir, { bufferLimit: 6 }),
    registerRuntime(dir, { bufferLimit: 6 }),
  ];
  assert.equal(
    restored.reduce(
      (sum, runtime) => sum + runtime.logs.filter((l) => l.includes("event=capture_pipeline")).length,
      0,
    ),
    1,
    "only one live runtime owns the restored durable journal",
  );

  agentEnd(restored[0], 
    { success: true, messages: [...turn(1).messages, ...turn(2).messages, ...turn(3).messages] },
    ctx,
  );
  await waitFor(() => calls.some((c) => c.name === "add_memory"));
  await waitFor(() => calls.some((c) => c.name === "get_episodes_by_ref"));

  const adds = calls.filter((c) => c.name === "add_memory");
  assert.equal(adds.length, 1);
  assert.equal(adds[0].arguments.name.endsWith("-1"), true);
  await restored[0].hooks.get("gateway_stop")();
});

test("a stopped pipeline is replaced rather than reused", async (t) => {
  resetCaptureRuntimeForTests();
  t.after(resetCaptureRuntimeForTests);
  installFetch(t);
  const dir = join(stateRoot, "revive");

  const first = registerRuntime(dir);
  await first.hooks.get("gateway_stop")();

  const second = registerRuntime(dir);
  assert.ok(second.logs.some((l) => l.includes('event=capture_pipeline outcome="replaced_stopped"')));
  agentEnd(second, turn(1), ctx);
  assert.ok(!second.logs.some((l) => l.includes("engine_rejected_messages")));
  await second.hooks.get("gateway_stop")();
});

test("hot reconfiguration cannot create a second live durable owner", async (t) => {
  resetCaptureRuntimeForTests();
  t.after(resetCaptureRuntimeForTests);
  installFetch(t);
  const dir = join(stateRoot, "reconfigured");

  const first = registerRuntime(dir, { bufferLimit: 4 });
  const changed = registerRuntime(dir, { bufferLimit: 9 });
  assert.ok(changed.logs.some((l) => l.includes('outcome="reused_config_mismatch"')));

  await first.hooks.get("gateway_stop")();
  const afterStop = registerRuntime(dir, { bufferLimit: 9 });
  assert.ok(afterStop.logs.some((l) => l.includes('outcome="replaced_reconfigured"')));
  await afterStop.hooks.get("gateway_stop")();
});

test("durable state for several agents never mixes their conversations", async (t) => {
  resetCaptureRuntimeForTests();
  t.after(resetCaptureRuntimeForTests);
  const dir = join(stateRoot, "multi-agent");
  const beforeCalls = installFetch(t);

  const gateway = registerRuntime(dir, { bufferLimit: 6 });
  agentEnd(gateway, 
    { success: true, messages: [{ role: "user", content: "секрет вита" }] },
    { agentId: "main", sessionKey: "agent:main:telegram:1", trigger: "user" },
  );
  agentEnd(gateway, 
    { success: true, messages: [{ role: "user", content: "секрет игоря" }] },
    { agentId: "igor", sessionKey: "agent:igor:telegram:2", trigger: "user" },
  );
  await gateway.hooks.get("gateway_stop")();
  assert.deepEqual(beforeCalls.filter((c) => c.name === "add_memory"), []);

  resetCaptureRuntimeForTests();
  const calls = installFetch(t);
  const after = registerRuntime(dir, { bufferLimit: 2 });
  agentEnd(after, 
    {
      success: true,
      messages: [
        { role: "user", content: "секрет вита" },
        { role: "assistant", content: "ответ виту" },
      ],
    },
    { agentId: "main", sessionKey: "agent:main:telegram:1", trigger: "user" },
  );
  await waitFor(() => calls.some((c) => c.name === "add_memory"));

  const adds = calls.filter((c) => c.name === "add_memory").map((c) => c.arguments);
  assert.equal(adds.length, 1);
  assert.equal(adds[0].group_id, "main");
  assert.match(adds[0].episode_body, /секрет вита/);
  assert.doesNotMatch(adds[0].episode_body, /секрет игоря/);
  await after.hooks.get("gateway_stop")();
});
