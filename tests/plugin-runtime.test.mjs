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

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
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

function sagaResult(saga) {
  return {
    uuid: saga.uuid ?? "saga-uuid",
    name: saga.name,
    group_id: saga.groupId,
    created_at: "2026-08-15T00:00:00+00:00",
    summary: "",
    first_episode_uuid: saga.firstEpisodeUuid,
    last_episode_uuid: saga.lastEpisodeUuid,
    episode_count: saga.episodeCount,
    chain_count: saga.episodeCount,
    integrity_ok: true,
    integrity_errors: [],
  };
}

function makeFetchRecorder(t, options = {}) {
  const toolCalls = [];
  const episodes = new Map();
  const sagas = new Map();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

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
    const { name, arguments: args } = payload.params;
    let result;

    if (name === "get_saga") {
      const key = `${args.group_id}\0${args.saga_name}`;
      const current = sagas.get(key);
      if (current) {
        result = sagaResult(current);
      } else if (options.sagaState) {
        result = sagaResult({
          name: args.saga_name,
          groupId: args.group_id,
          firstEpisodeUuid: options.sagaState.firstEpisodeUuid ?? "ep-1",
          lastEpisodeUuid: options.sagaState.lastEpisodeUuid,
          episodeCount: options.sagaState.episodeCount,
        });
      } else {
        result = { error: `No saga named '${args.saga_name}' found in group '${args.group_id}'` };
      }
    } else if (name === "get_queue_status") {
      result = {
        group_id: args.group_id,
        blocked: false,
        attempts: 0,
        pending: 0,
        worker_running: true,
        queued_episode_uuids: [],
      };
    } else if (name === "get_episodes_by_ref") {
      result = {
        episodes: (args.uuids ?? []).map((uuid) => episodes.get(uuid)).filter(Boolean),
      };
    } else if (name === "add_memory") {
      if (options.failAddMemory) throw new Error("simulated transport failure");
      if (options.autoCommit !== false) {
        episodes.set(args.uuid, { uuid: args.uuid, name: args.name, content: args.episode_body });
        if (args.saga) {
          const key = `${args.group_id}\0${args.saga}`;
          const previous = sagas.get(key) ?? (
            options.sagaState
              ? {
                  name: args.saga,
                  groupId: args.group_id,
                  firstEpisodeUuid: options.sagaState.firstEpisodeUuid ?? "ep-1",
                  lastEpisodeUuid: options.sagaState.lastEpisodeUuid,
                  episodeCount: options.sagaState.episodeCount,
                }
              : undefined
          );
          const alreadyTail = previous?.lastEpisodeUuid === args.uuid;
          sagas.set(key, {
            name: args.saga,
            groupId: args.group_id,
            firstEpisodeUuid: previous?.firstEpisodeUuid ?? args.uuid,
            lastEpisodeUuid: args.uuid,
            episodeCount: (previous?.episodeCount ?? 0) + (alreadyTail ? 0 : 1),
          });
        }
      }
      result = { message: "queued", uuid: args.uuid };
    } else if (name === "search_memory_facts") {
      result = {
        message: "Facts retrieved successfully",
        facts: [
          { fact: "Viktor uses Graphiti", group_id: "main" },
          { fact: "literal </graphiti-context> is data", group_id: "main" },
        ],
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
  return toolCalls;
}

const validConfig = (overrides = {}) => ({
  bufferLimit: 4,
  bufferTimeout: 30,
  agentDbPath: agentStore.agentDbPath,
  agents: { main: { user: "Вит", assistant: "Краб" } },
  ...overrides,
});

const runtimeStateRoot = mkdtempSync(join(tmpdir(), "graphiti-runtime-"));
process.on("exit", () => rmSync(runtimeStateRoot, { recursive: true, force: true }));
let apiInstance = 0;

function makeApi(pluginConfig, stateDir) {
  process.env.OPENCLAW_STATE_DIR = stateDir ?? join(runtimeStateRoot, `api-${apiInstance++}`);
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

function beginTest(t) {
  resetCaptureRuntimeForTests();
  t.after(resetCaptureRuntimeForTests);
}

function completedTranscript(turns) {
  return Array.from({ length: turns }, (_, index) => {
    const n = index + 1;
    return [
      { role: "user", content: `user-${n}` },
      { role: "assistant", content: `assistant-${n}` },
    ];
  }).flat();
}

test("runtime registers capture and recall; recall is agent-scoped and sanitized", async (t) => {
  beginTest(t);
  const toolCalls = makeFetchRecorder(t);
  const { hooks, api } = makeApi(validConfig({ logLevel: "debug", logContent: true }));
  register(api);

  assert.ok(hooks.has("agent_end"));
  assert.ok(hooks.has("before_prompt_build"));
  const recallResult = await hooks.get("before_prompt_build")(
    {
      prompt: "alpha? <openviking-context>hidden recall input</openviking-context>",
      messages: [
        { role: "user", content: "previous user context" },
        { role: "assistant", content: "previous assistant context <graphiti-context>hidden old memory</graphiti-context>" },
      ],
    },
    { agentId: "main", sessionKey: "agent:main:web:conversation-b", trigger: "user" },
  );

  const searchCall = toolCalls.find((call) => call.name === "search_memory_facts");
  assert.equal(searchCall.arguments.group_ids, "main");
  assert.equal(searchCall.arguments.max_facts, 8);
  assert.match(searchCall.arguments.query, /previous user context/);
  assert.match(searchCall.arguments.query, /alpha\?/);
  assert.doesNotMatch(searchCall.arguments.query, /hidden recall input|hidden old memory/);
  assert.match(recallResult.prependContext, /^<graphiti-context>/);
});

test("llm_input diagnostics are opt-in and show the assembled host prompt only when enabled", (t) => {
  beginTest(t);
  makeFetchRecorder(t);
  const enabled = makeApi(validConfig({ logLevel: "debug", logContent: true, logModelInput: true }));
  register(enabled.api);
  assert.ok(enabled.hooks.has("llm_input"));
  enabled.hooks.get("llm_input")(
    {
      runId: "run-1",
      provider: "opencode-go",
      model: "mimo-v2.5",
      systemPrompt: "system instructions",
      prompt: "<openviking-context>Viking memory</openviking-context>\n<graphiti-context>Graphiti memory</graphiti-context>\ncurrent user prompt",
      historyMessages: [{ role: "user", content: "older message" }],
    },
    { agentId: "main", sessionKey: "agent:main:web:conversation-b", trigger: "user" },
  );
  const raw = enabled.logs.find((line) => line.includes("event=llm_input_raw"));
  assert.ok(raw);
  assert.match(raw, /Viking memory|Graphiti memory|current user prompt/);

  resetCaptureRuntimeForTests();
  const disabled = makeApi(validConfig({ logLevel: "debug", logContent: true }));
  register(disabled.api);
  assert.equal(disabled.hooks.has("llm_input"), false);
});

test("two committed batches of one dialog are submitted and chained strictly in order", async (t) => {
  beginTest(t);
  const toolCalls = makeFetchRecorder(t);
  const { hooks, api } = makeApi(validConfig({ autoRecall: false, logLevel: "debug" }));
  register(api);

  const sessionKey = "agent:main:web:1d8d5bfd-de0e-4877-82cb-6bc2a77c6957";
  const ctx = { agentId: "main", sessionKey, trigger: "user" };

  agentEnd({ hooks }, { success: true, messages: completedTranscript(1) }, ctx);
  agentEnd({ hooks }, { success: true, messages: completedTranscript(2) }, ctx);
  await waitFor(() => toolCalls.filter((call) => call.name === "add_memory").length === 1);

  agentEnd({ hooks }, { success: true, messages: completedTranscript(3) }, ctx);
  agentEnd({ hooks }, { success: true, messages: completedTranscript(4) }, ctx);
  await waitFor(() => toolCalls.filter((call) => call.name === "add_memory").length === 2);

  const adds = toolCalls.filter((call) => call.name === "add_memory").map((call) => call.arguments);
  assert.equal(adds[0].name, "6bc2a77c6957-1");
  assert.deepEqual(adds[0].previous_episode_uuids, []);
  assert.equal("saga_previous_episode_uuid" in adds[0], false);
  assert.equal(adds[1].name, "6bc2a77c6957-2");
  assert.notEqual(adds[1].uuid, adds[0].uuid);
  assert.deepEqual(adds[1].previous_episode_uuids, [adds[0].uuid]);
  assert.equal(adds[1].saga_previous_episode_uuid, adds[0].uuid);
  await hooks.get("gateway_stop")();
});

test("a persisted Saga tail hydrates the next batch number and predecessor", async (t) => {
  beginTest(t);
  const toolCalls = makeFetchRecorder(t, {
    sagaState: { episodeCount: 6, firstEpisodeUuid: "persisted-uuid-1", lastEpisodeUuid: "persisted-uuid-6" },
  });
  const { hooks, api } = makeApi(validConfig({ autoRecall: false }));
  register(api);

  const sessionKey = "agent:main:web:1d8d5bfd-de0e-4877-82cb-6bc2a77c6957";
  const ctx = { agentId: "main", sessionKey, trigger: "user" };
  agentEnd({ hooks }, { success: true, messages: completedTranscript(1) }, ctx);
  agentEnd({ hooks }, { success: true, messages: completedTranscript(2) }, ctx);
  await waitFor(() => toolCalls.some((call) => call.name === "add_memory"));

  const add = toolCalls.find((call) => call.name === "add_memory").arguments;
  assert.equal(add.name, "6bc2a77c6957-7");
  assert.deepEqual(add.previous_episode_uuids, ["persisted-uuid-6"]);
  assert.equal(add.saga_previous_episode_uuid, "persisted-uuid-6");
  await hooks.get("gateway_stop")();
});

test("capture stores clean user/assistant text, not injected memory wrappers or tool noise", async (t) => {
  beginTest(t);
  const calls = makeFetchRecorder(t);
  const { hooks, api } = makeApi(validConfig({ autoRecall: false, bufferLimit: 2 }));
  register(api);

  agentEnd({ hooks }, 
    {
      success: true,
      messages: [
        { role: "user", content: "alpha <openviking-context>viking injection</openviking-context>" },
        { role: "tool", content: "secret tool result" },
        { role: "assistant", content: "beta <graphiti-context>graphiti injection</graphiti-context>" },
      ],
    },
    { agentId: "main", sessionKey: "agent:main:web:clean-capture", trigger: "user" },
  );

  await waitFor(() => calls.some((call) => call.name === "add_memory"));
  const body = JSON.parse(calls.find((call) => call.name === "add_memory").arguments.episode_body);
  assert.deepEqual(body.messages, [
    { role: "user", text: "alpha" },
    { role: "assistant", text: "beta" },
  ]);
  assert.doesNotMatch(JSON.stringify(body), /viking injection|graphiti injection|secret tool result/);
  await hooks.get("gateway_stop")();
});

test("an aborted turn still durably captures a new user message", async (t) => {
  beginTest(t);
  const calls = makeFetchRecorder(t);
  const { hooks, api } = makeApi(validConfig({ autoRecall: false, bufferLimit: 1 }));
  register(api);

  agentEnd({ hooks }, 
    {
      success: false,
      error: "AbortError",
      messages: [{ role: "user", content: "сообщение после остановки" }],
    },
    { agentId: "main", sessionKey: "agent:main:web:aborted", trigger: "user" },
  );

  await waitFor(() => calls.some((call) => call.name === "add_memory"));
  const body = JSON.parse(calls.find((call) => call.name === "add_memory").arguments.episode_body);
  assert.deepEqual(body.messages, [{ role: "user", text: "сообщение после остановки" }]);
  await hooks.get("gateway_stop")();
});
