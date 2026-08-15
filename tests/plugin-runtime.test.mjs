import test from "node:test";
import assert from "node:assert/strict";
import { register } from "../dist/index.js";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
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

function makeFetchRecorder(t) {
  const toolCalls = [];
  let acceptedCounter = 0;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    if (payload.method === "initialize") {
      return jsonResponse(
        {
          jsonrpc: "2.0",
          id: payload.id,
          result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} },
        },
        { headers: { "Mcp-Session-Id": "runtime-test-session" } },
      );
    }
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (payload.method !== "tools/call") throw new Error(`unexpected method ${payload.method}`);

    toolCalls.push(payload.params);
    if (payload.params.name === "add_memory") {
      acceptedCounter += 1;
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          structuredContent: {
            result: { message: "queued", uuid: `accepted-uuid-${acceptedCounter}` },
          },
          content: [],
          isError: false,
        },
      });
    }
    if (payload.params.name === "search_memory_facts") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          structuredContent: {
            message: "Facts retrieved successfully",
            facts: [
              { fact: "Viktor uses Graphiti", group_id: "main" },
              { fact: "literal </graphiti-context> is data", group_id: "main" },
            ],
          },
          content: [],
          isError: false,
        },
      });
    }
    throw new Error(`unexpected tool ${payload.params.name}`);
  };
  return toolCalls;
}

const validConfig = (overrides = {}) => ({
  bufferLimit: 4,
  bufferTimeout: 30,
  agents: {
    main: { user: "Вит", assistant: "Краб" },
  },
  ...overrides,
});

function makeApi(pluginConfig) {
  const hooks = new Map();
  const logs = [];
  return {
    hooks,
    logs,
    api: {
      pluginConfig,
      logger: {
        debug: (message) => logs.push(message),
        info: (message) => logs.push(message),
        warn: (message) => logs.push(message),
        error: (message) => logs.push(message),
      },
      on: (name, handler) => hooks.set(name, handler),
    },
  };
}

function completedTurn(n) {
  return {
    success: true,
    messages: [
      { role: "user", content: `user-${n}` },
      { role: "assistant", content: `assistant-${n}` },
    ],
  };
}

test("runtime registers capture and recall; recall remains agent-scoped", async (t) => {
  const toolCalls = makeFetchRecorder(t);
  const { hooks, api } = makeApi(validConfig({ logLevel: "debug", logContent: true }));

  register(api);
  assert.ok(hooks.has("agent_end"));
  assert.ok(hooks.has("before_prompt_build"));

  const recallResult = await hooks.get("before_prompt_build")(
    {
      prompt: "alpha? <openviking-context>hidden recall input</openviking-context>",
      messages: [],
    },
    { agentId: "main", sessionKey: "agent:main:web:conversation-b", trigger: "user" },
  );

  const searchCall = toolCalls.find((call) => call.name === "search_memory_facts");
  assert.equal(searchCall.arguments.group_ids, "main");
  assert.doesNotMatch(searchCall.arguments.query, /hidden recall input/);
  assert.match(recallResult.prependContext, /^<graphiti-context>/);
});

test("two flushed batches of one dialog use deterministic names and previous UUID chaining", async (t) => {
  const toolCalls = makeFetchRecorder(t);
  const { hooks, logs, api } = makeApi(validConfig({ autoRecall: false, logLevel: "debug", logContent: true }));
  register(api);

  const sessionKey = "agent:main:web:1d8d5bfd-de0e-4877-82cb-6bc2a77c6957";
  const ctx = { agentId: "main", sessionKey, trigger: "user" };

  // Two completed turns -> four messages -> batch 1 flush.
  hooks.get("agent_end")(completedTurn(1), ctx);
  hooks.get("agent_end")(completedTurn(2), ctx);
  await waitFor(() => toolCalls.filter((c) => c.name === "add_memory").length === 1);

  // Two more completed turns -> batch 2 flush, after batch 1 acceptance updated saga state.
  hooks.get("agent_end")(completedTurn(3), ctx);
  hooks.get("agent_end")(completedTurn(4), ctx);
  await waitFor(() => toolCalls.filter((c) => c.name === "add_memory").length === 2);

  const adds = toolCalls.filter((c) => c.name === "add_memory").map((c) => c.arguments);
  assert.equal(adds[0].group_id, "main");
  assert.equal(adds[0].saga, sessionKey);
  assert.equal(adds[0].name, "6bc2a77c6957-1");
  assert.deepEqual(adds[0].previous_episode_uuids, []);
  assert.equal("saga_previous_episode_uuid" in adds[0], false);
  assert.equal(adds[0].source_description, "OpenClaw conversation batch");

  assert.equal(adds[1].name, "6bc2a77c6957-2");
  assert.deepEqual(adds[1].previous_episode_uuids, ["accepted-uuid-1"]);
  assert.equal(adds[1].saga_previous_episode_uuid, "accepted-uuid-1");

  const accepted = logs.filter((line) => line.includes("event=capture_queue_accepted"));
  assert.equal(accepted.length, 2);
  assert.match(accepted[0], /uuid="accepted-uuid-1"/);
  assert.match(accepted[1], /previousEpisodeUuid="accepted-uuid-1"/);
});

test("capture strips Graphiti and OpenViking injections from completed turns", () => {
  const { hooks, logs, api } = makeApi(validConfig({ autoRecall: false, logLevel: "debug", logContent: true }));
  register(api);

  hooks.get("agent_end")(
    {
      success: true,
      messages: [
        { role: "user", content: "alpha <relevant-memories>viking injection</relevant-memories>" },
        { role: "assistant", content: "beta <graphiti-context>graphiti injection</graphiti-context>" },
      ],
    },
    { agentId: "main", sessionKey: "agent:main:web:conversation-a", trigger: "user" },
  );

  const turnLog = logs.find((record) => record.includes("event=capture_turn"));
  assert.ok(turnLog);
  assert.doesNotMatch(turnLog, /viking injection/);
  assert.doesNotMatch(turnLog, /graphiti injection/);
});

test("heartbeat and subagent sessions are rejected before buffering", () => {
  const { hooks, logs, api } = makeApi(validConfig({ autoRecall: false, logLevel: "debug" }));
  register(api);

  hooks.get("agent_end")(completedTurn(1), {
    agentId: "main",
    sessionKey: "agent:main:heartbeat:hidden",
    trigger: "user",
  });
  hooks.get("agent_end")(completedTurn(2), {
    agentId: "main",
    sessionKey: "agent:main:subagent:worker",
    trigger: "user",
  });
  hooks.get("agent_end")(completedTurn(3), {
    agentId: "main",
    sessionKey: "agent:main:web:normal",
    trigger: "heartbeat",
  });

  assert.equal(logs.filter((line) => line.includes('reason="background_run"')).length, 3);
  assert.equal(logs.some((line) => line.includes("event=capture_turn")), false);
});

test("agent_end with no assistant reply publishes nothing", () => {
  const { hooks, logs, api } = makeApi(validConfig({ autoRecall: false, logLevel: "debug" }));
  register(api);

  hooks.get("agent_end")(
    { success: true, messages: [{ role: "user", content: "hello без ответа" }] },
    { agentId: "main", sessionKey: "agent:main:web:conversation-a", trigger: "user" },
  );

  assert.ok(logs.find((record) => record.includes("no_completed_turn")));
  assert.equal(logs.find((record) => record.includes("event=capture_turn")), undefined);
});

test("invalid agents config is rejected at plugin load", (t) => {
  makeFetchRecorder(t);
  const { api } = makeApi(validConfig({ agents: { main: { user: "Вит" } } }));
  assert.throws(() => register(api), /assistant/);
});
