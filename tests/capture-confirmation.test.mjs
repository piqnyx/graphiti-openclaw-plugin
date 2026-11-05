import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "../dist/index.js";
import { resolveDurableCaptureRoot } from "../dist/capture-pipeline.js";
import { DurableQueueStore } from "../dist/durable-queue-store.js";
import { makeAgentStore } from "./helpers-agent-store.mjs";
const agentStore = makeAgentStore();

// The gateway writes its transcript and then fires the hook; capture reads the
// store, not the hook payload. Tests still describe a turn as a message list, so
// the fixture writes it first and the hook only says "a turn ended".
const agentEnd = (runtime, event, context) => {
  agentStore.deliver(context?.agentId ?? "main", context?.sessionKey ?? "", event?.messages ?? []);
  return runtime.hooks.get("agent_end")(event, context);
};

function isolateStateDir(t) {
  const stateDir = mkdtempSync(join(tmpdir(), "graphiti-confirm-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  return stateDir;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(`${what} did not happen before the timeout`);
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function harness(t, handlers) {
  isolateStateDir(t);
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
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
    const handler = handlers[payload.params.name];
    if (!handler) throw new Error(`unexpected tool ${payload.params.name}`);
    return jsonResponse({
      jsonrpc: "2.0",
      id: payload.id,
      result: { structuredContent: { result: handler(payload.params.arguments) } },
    });
  };

  const hooks = new Map();
  register({
    pluginConfig: {
      autoCapture: true,
      autoRecall: false,
      agentTools: false,
      bufferLimit: 2,
      logLevel: "debug",
      agentDbPath: agentStore.agentDbPath,
      agents: { main: { user: "Вит", assistant: "Краб" } },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on: (event, handler) => hooks.set(event, handler),
  });

  t.after(async () => {
    const stop = hooks.get("gateway_stop");
    if (stop) await stop();
  });

  return { calls, hooks, queue: new DurableQueueStore(resolveDurableCaptureRoot()) };
}

const turn = (hooks) =>
  agentEnd({ hooks }, 
    {
      success: true,
      messages: [
        { role: "user", content: "привет" },
        { role: "assistant", content: "здравствуй" },
      ],
    },
    { agentId: "main", sessionKey: "agent:main:telegram:1", trigger: "user" },
  );

function healthySaga(uuid) {
  return {
    uuid: "saga-1",
    name: "agent:main:telegram:1",
    group_id: "main",
    summary: "",
    first_episode_uuid: uuid,
    last_episode_uuid: uuid,
    episode_count: 1,
    chain_count: 1,
    integrity_ok: true,
    integrity_errors: [],
  };
}

test("queued is not delivery: durable head remains until exact Saga commit is visible", async (t) => {
  let episodeExists = false;
  let submittedUuid;
  const { calls, hooks, queue } = harness(t, {
    get_saga: () =>
      episodeExists && submittedUuid
        ? healthySaga(submittedUuid)
        : { error: "No saga named 'agent:main:telegram:1' found in group 'main'" },
    add_memory: (args) => {
      submittedUuid = args.uuid;
      return { message: "queued", uuid: args.uuid };
    },
    get_queue_status: () => ({
      group_id: "main",
      blocked: false,
      attempts: 0,
      pending: 0,
      worker_running: false,
      queued_episode_uuids: [],
    }),
    get_episodes_by_ref: () => ({
      episodes:
        episodeExists && submittedUuid
          ? [{ uuid: submittedUuid, name: "1-1", group_id: "main" }]
          : [],
    }),
  });

  turn(hooks);
  await waitFor(() => calls.some((call) => call.name === "add_memory"), "initial add_memory");
  assert.equal(queue.approximateDepth("main"), 1, "MCP queued response must not remove disk head");

  const head = queue.peekHead("main");
  assert.equal(head.payload.episode.uuid, submittedUuid);
  assert.ok(head.payload.buffer.messages.some((message) => message.text === "привет"));

  episodeExists = true;
  await waitFor(() => queue.approximateDepth("main") === 0, "committed head removal");
});

test("deterministic Graphiti identity is fsynced into the head before remote submission", async (t) => {
  let submittedUuid;
  let episodeExists = false;
  const { calls, hooks, queue } = harness(t, {
    get_saga: () =>
      episodeExists && submittedUuid
        ? healthySaga(submittedUuid)
        : { error: "No saga named 'agent:main:telegram:1' found in group 'main'" },
    add_memory: (args) => {
      submittedUuid = args.uuid;
      return { message: "queued", uuid: args.uuid };
    },
    get_queue_status: () => ({
      group_id: "main",
      blocked: false,
      attempts: 0,
      pending: 0,
      worker_running: false,
      queued_episode_uuids: [],
    }),
    get_episodes_by_ref: () => ({
      episodes: episodeExists && submittedUuid ? [{ uuid: submittedUuid }] : [],
    }),
  });

  turn(hooks);
  await waitFor(() => calls.some((call) => call.name === "add_memory"), "initial add_memory");

  const sent = calls.find((call) => call.name === "add_memory").arguments;
  const head = queue.peekHead("main");
  assert.equal(head.payload.episode.uuid, sent.uuid);
  assert.equal(head.payload.episode.name, sent.name);
  assert.equal(head.payload.episode.batchNumber, 1);
  assert.equal(head.payload.episode.previousEpisodeUuid, undefined);
  assert.equal(new Date(head.enqueuedAt).toISOString(), sent.reference_time);

  episodeExists = true;
  await waitFor(() => queue.approximateDepth("main") === 0, "committed head removal");
});

test("a head whose first delivery failed after its identity was reserved is delivered on the next retry", async (t) => {
  // 02.11-05.11: a failure after the identity was reserved left it pending in this process, and
  // every retry took the restart path, which refuses a pending batch -- stuck until a restart.
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  let submittedUuid;
  let lookups = 0;
  const { calls, hooks, queue } = harness(t, {
    get_saga: () =>
      submittedUuid
        ? healthySaga(submittedUuid)
        : { error: "No saga named 'agent:main:telegram:1' found in group 'main'" },
    get_episodes_by_ref: () =>
      ++lookups === 1
        ? { error: "Error retrieving episodes: Query timed out" }
        : { episodes: submittedUuid ? [{ uuid: submittedUuid }] : [] },
    get_queue_status: () => ({
      group_id: "main",
      blocked: false,
      attempts: 0,
      pending: 0,
      worker_running: false,
      queued_episode_uuids: [],
    }),
    add_memory: (args) => {
      submittedUuid = args.uuid;
      return { message: "queued", uuid: args.uuid };
    },
  });

  await turn(hooks);
  await waitSteps(() => lookups === 1, "the first delivery attempt");
  assert.ok(queue.peekHead("main"), "the head stays after the failed attempt");

  t.mock.timers.tick(30_000);
  await waitSteps(() => !queue.peekHead("main"), "delivery on the next retry");
  assert.equal(calls.filter((call) => call.name === "add_memory").length, 1);
});

// Bounded by a count, not a clock: the tests below mock Date, which would freeze waitFor's deadline.
async function waitSteps(predicate, what) {
  for (let i = 0; i < 300; i += 1) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(`${what} did not happen`);
}

const idleQueue = (episodeUuid) => ({
  group_id: "main",
  blocked: false,
  attempts: 0,
  pending: 0,
  worker_running: true,
  episode_uuid: episodeUuid ?? null,
  queued_episode_uuids: [],
});
const noSaga = { error: "No saga named 'agent:main:telegram:1' found in group 'main'" };

test("a head whose commit landed while its first attempt failed is removed on retry without a second submission", async (t) => {
  // The incident's shape: the episode was committed, the attempt still failed, and the retry in the
  // same process must remove the head rather than stay stuck or submit again.
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  let submittedUuid;
  let submissions = 0;
  let lookups = 0;
  const committed = () => submittedUuid !== undefined && lookups >= 3;
  const { hooks, queue } = harness(t, {
    get_saga: () => (committed() ? healthySaga(submittedUuid) : noSaga),
    get_episodes_by_ref: () => {
      lookups += 1;
      if (lookups === 2) return { error: "Error retrieving episodes: Query timed out" };
      return { episodes: committed() ? [{ uuid: submittedUuid }] : [] };
    },
    get_queue_status: () => idleQueue(),
    add_memory: (args) => {
      submittedUuid = args.uuid;
      submissions += 1;
      return { message: "queued", uuid: args.uuid };
    },
  });

  await turn(hooks);
  await waitSteps(() => lookups === 2, "the failure after submission");
  assert.ok(queue.peekHead("main"), "the head stays after the failed attempt");

  t.mock.timers.tick(30_000);
  await waitSteps(() => !queue.peekHead("main"), "removal on the next retry");
  assert.equal(submissions, 1);
});

test("a retry after a failure that followed the submission asks the backend before submitting again", async (t) => {
  // The head carries a reserved identity, so the backend may still be extracting it; submitting it
  // again would rely on the server ignoring the duplicate. The retry asks the queue first.
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  let submittedUuid;
  let submissions = 0;
  let lookups = 0;
  const committed = () => lookups >= 4;
  const { hooks, queue } = harness(t, {
    get_saga: () => (submittedUuid && committed() ? healthySaga(submittedUuid) : noSaga),
    get_episodes_by_ref: () => {
      lookups += 1;
      if (lookups === 2) return { error: "Error retrieving episodes: Query timed out" };
      return { episodes: committed() ? [{ uuid: submittedUuid }] : [] };
    },
    get_queue_status: () => idleQueue(submittedUuid),
    add_memory: (args) => {
      submittedUuid = args.uuid;
      submissions += 1;
      return { message: "queued", uuid: args.uuid };
    },
  });

  await turn(hooks);
  await waitSteps(() => lookups === 2, "the failure after submission");
  assert.equal(submissions, 1);

  t.mock.timers.tick(30_000);
  await waitSteps(() => !queue.peekHead("main"), "delivery on the next retry");
  assert.equal(submissions, 1, "the episode the backend was still running is not submitted again");
});

test("after a restart, a head the backend already committed is removed without a second submission", async (t) => {
  // The restart path (an empty sequence tracker) must still reconcile against the graph.
  isolateStateDir(t);
  const sessionKey = "agent:main:telegram:1";
  const calls = [];
  const infos = [];
  let submittedUuid;
  let committed = false;
  const handlers = {
    get_saga: () => (committed ? healthySaga(submittedUuid) : noSaga),
    get_episodes_by_ref: () => ({ episodes: committed ? [{ uuid: submittedUuid }] : [] }),
    get_queue_status: () => idleQueue(committed ? undefined : submittedUuid),
    add_memory: (args) => {
      submittedUuid = args.uuid;
      return { message: "queued", uuid: args.uuid };
    },
  };
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
    calls.push(payload.params.name);
    return jsonResponse({
      jsonrpc: "2.0",
      id: payload.id,
      result: { structuredContent: { result: handlers[payload.params.name](payload.params.arguments) } },
    });
  };
  const start = () => {
    const hooks = new Map();
    register({
      pluginConfig: {
        autoCapture: true,
        autoRecall: false,
        agentTools: false,
        bufferLimit: 2,
        logLevel: "debug",
        agentDbPath: agentStore.agentDbPath,
        agents: { main: { user: "Вит", assistant: "Краб" } },
      },
      logger: { debug() {}, info: (line) => infos.push(String(line)), warn() {}, error() {} },
      on: (event, handler) => hooks.set(event, handler),
    });
    return hooks;
  };

  let hooks = start();
  await turn(hooks);
  await waitSteps(() => calls.includes("add_memory"), "the first submission");
  await hooks.get("gateway_stop")();
  committed = true; // the backend finished the extraction while the gateway was down

  const afterRestart = calls.length;
  hooks = start();
  t.after(async () => {
    await hooks.get("gateway_stop")();
  });
  const queue = new DurableQueueStore(resolveDurableCaptureRoot());
  await waitSteps(() => !queue.peekHead("main"), "removal after the restart");
  assert.ok(!calls.slice(afterRestart).includes("add_memory"), "no second submission");
  assert.ok(infos.some((line) => line.includes("capture_replay_already_committed")));
});
