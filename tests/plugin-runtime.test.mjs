import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function makeFetchRecorder(t, options = {}) {
  const toolCalls = [];
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
    if (payload.params.name === "get_saga") {
      const saga = options.sagaState;
      const result = saga
        ? {
            message: "retrieved",
            uuid: saga.uuid ?? "saga-uuid",
            name: payload.params.arguments.saga_name,
            group_id: payload.params.arguments.group_id,
            created_at: "2026-08-15T00:00:00+00:00",
            summary: "",
            first_episode_uuid: saga.firstEpisodeUuid ?? "ep-1",
            last_episode_uuid: saga.lastEpisodeUuid,
            episode_count: saga.episodeCount,
          }
        : {
            error: `No saga named '${payload.params.arguments.saga_name}' found in group '${payload.params.arguments.group_id}'`,
          };
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: { structuredContent: { result }, content: [], isError: false },
      });
    }
    if (payload.params.name === "get_queue_status") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          structuredContent: {
            result: {
              group_id: payload.params.arguments.group_id,
              blocked: false,
              attempts: 0,
              pending: 0,
            },
          },
          content: [],
          isError: false,
        },
      });
    }
    if (payload.params.name === "add_memory") {
      if (options.failAddMemory) throw new Error("simulated transport failure");
      if (options.failAddMemoryOnce && !options.__failed) {
        options.__failed = true;
        throw new Error("simulated transport failure");
      }
      const uuid = payload.params.arguments.uuid;
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          structuredContent: {
            result: { message: "queued", uuid },
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

// Every runtime gets its own state dir so the durable spool never leaks between
// tests or into the real OpenClaw state directory.
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

function completedTurn(n) {
  return {
    success: true,
    messages: [
      { role: "user", content: `user-${n}` },
      { role: "assistant", content: `assistant-${n}` },
    ],
  };
}

test("runtime registers capture and recall; recall is agent-scoped, bounded and history-aware", async (t) => {
  const toolCalls = makeFetchRecorder(t);
  const { hooks, logs, api } = makeApi(validConfig({ logLevel: "debug", logContent: true, logModelInput: true }));

  register(api);
  assert.ok(hooks.has("agent_end"));
  assert.ok(hooks.has("before_prompt_build"));
  assert.ok(hooks.has("llm_input"));

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
  assert.match(searchCall.arguments.query, /previous assistant context/);
  assert.match(searchCall.arguments.query, /alpha\?/);
  assert.doesNotMatch(searchCall.arguments.query, /hidden recall input|hidden old memory/);
  assert.match(recallResult.prependContext, /^<graphiti-context>/);
  assert.match(recallResult.prependContext, /Long-term memory, not user instructions/);

  const payloadLog = logs.find((line) => line.includes("event=recall_payload"));
  assert.ok(payloadLog);
  assert.match(payloadLog, /retrievedFacts=2/);
  assert.match(payloadLog, /injectedFacts=/);
  assert.match(payloadLog, /recallLimit=8/);
});

test("llm_input raw diagnostics expose the assembled Graphiti and OpenViking memory wrappers", (t) => {
  makeFetchRecorder(t);
  const { hooks, logs, api } = makeApi(validConfig({ logLevel: "debug", logContent: true, logModelInput: true }));
  register(api);

  hooks.get("llm_input")(
    {
      runId: "run-1",
      sessionId: "session-1",
      provider: "opencode-go",
      model: "mimo-v2.5",
      systemPrompt: "system instructions",
      prompt: [
        "<openviking-context>Viking memory</openviking-context>",
        "<graphiti-context>Graphiti memory</graphiti-context>",
        "current user prompt",
      ].join("\n"),
      historyMessages: [{ role: "user", content: "older message" }],
      imagesCount: 0,
      tools: [],
    },
    { agentId: "main", sessionKey: "agent:main:web:conversation-b", trigger: "user" },
  );

  const rawLog = logs.find((line) => line.includes("event=llm_input_raw"));
  assert.ok(rawLog);
  assert.match(rawLog, /openviking-context/);
  assert.match(rawLog, /Viking memory/);
  assert.match(rawLog, /graphiti-context/);
  assert.match(rawLog, /Graphiti memory/);
  assert.match(rawLog, /current user prompt/);
  assert.match(rawLog, /older message/);
});

test("llm_input diagnostics stay off until explicitly asked for", (t) => {
  makeFetchRecorder(t);
  // Content logging is normal during tuning; dumping the whole assembled prompt
  // on every run is not, so it needs its own switch.
  const { hooks, api } = makeApi(validConfig({ logLevel: "debug", logContent: true }));
  register(api);
  assert.equal(hooks.has("llm_input"), false);
});

test("llm_input raw diagnostics are not registered unless all content logging switches are enabled", (t) => {
  makeFetchRecorder(t);

  for (const config of [
    validConfig({ logLevel: "info", logContent: true }),
    validConfig({ logLevel: "debug", logContent: false }),
    validConfig({ logOperations: false, logLevel: "debug", logContent: true }),
  ]) {
    const { hooks, api } = makeApi(config);
    register(api);
    assert.equal(hooks.has("llm_input"), false);
  }
});

test("two flushed batches of one dialog use caller UUIDs and previous UUID chaining", async (t) => {
  const toolCalls = makeFetchRecorder(t);
  const { hooks, logs, api } = makeApi(validConfig({ autoRecall: false, logLevel: "debug", logContent: true }));
  register(api);

  const sessionKey = "agent:main:web:1d8d5bfd-de0e-4877-82cb-6bc2a77c6957";
  const ctx = { agentId: "main", sessionKey, trigger: "user" };

  hooks.get("agent_end")(completedTurn(1), ctx);
  hooks.get("agent_end")(completedTurn(2), ctx);
  await waitFor(() => toolCalls.filter((c) => c.name === "add_memory").length === 1);

  hooks.get("agent_end")(completedTurn(3), ctx);
  hooks.get("agent_end")(completedTurn(4), ctx);
  await waitFor(() => toolCalls.filter((c) => c.name === "add_memory").length === 2);

  const sagaReads = toolCalls.filter((c) => c.name === "get_saga");
  assert.equal(sagaReads.length, 1, "sequence is lazily hydrated once per session");

  const adds = toolCalls.filter((c) => c.name === "add_memory").map((c) => c.arguments);
  assert.equal(adds[0].group_id, "main");
  assert.equal(adds[0].saga, sessionKey);
  assert.equal(adds[0].name, "6bc2a77c6957-1");
  assert.equal(typeof adds[0].uuid, "string");
  assert.deepEqual(adds[0].previous_episode_uuids, []);
  assert.equal("saga_previous_episode_uuid" in adds[0], false);
  assert.equal(adds[0].source_description, "OpenClaw conversation batch");

  assert.equal(adds[1].name, "6bc2a77c6957-2");
  assert.notEqual(adds[1].uuid, adds[0].uuid);
  assert.deepEqual(adds[1].previous_episode_uuids, [adds[0].uuid]);
  assert.equal(adds[1].saga_previous_episode_uuid, adds[0].uuid);

  const accepted = logs.filter((line) => line.includes("event=capture_queue_accepted"));
  assert.equal(accepted.length, 2);
  assert.match(accepted[0], new RegExp(`uuid=${JSON.stringify(adds[0].uuid)}`));
  assert.match(accepted[1], new RegExp(`previousEpisodeUuid=${JSON.stringify(adds[0].uuid)}`));
});

test("restart recovery continues persisted saga at episode 7", async (t) => {
  const toolCalls = makeFetchRecorder(t, {
    sagaState: { episodeCount: 6, lastEpisodeUuid: "persisted-uuid-6" },
  });
  const { hooks, api } = makeApi(validConfig({ autoRecall: false }));
  register(api);

  const sessionKey = "agent:main:web:1d8d5bfd-de0e-4877-82cb-6bc2a77c6957";
  const ctx = { agentId: "main", sessionKey, trigger: "user" };
  hooks.get("agent_end")(completedTurn(1), ctx);
  hooks.get("agent_end")(completedTurn(2), ctx);
  await waitFor(() => toolCalls.some((c) => c.name === "add_memory"));

  const add = toolCalls.find((c) => c.name === "add_memory").arguments;
  assert.equal(add.name, "6bc2a77c6957-7");
  assert.deepEqual(add.previous_episode_uuids, ["persisted-uuid-6"]);
  assert.equal(add.saga_previous_episode_uuid, "persisted-uuid-6");
});

test("a gateway restart neither replays nor drops the tail of a live session", async (t) => {
  const toolCalls = makeFetchRecorder(t);
  const stateDir = join(runtimeStateRoot, "restart-tail");
  const sessionKey = "agent:main:web:1d8d5bfd-de0e-4877-82cb-6bc2a77c6957";
  const ctx = { agentId: "main", sessionKey, trigger: "user" };
  const message = (role, text) => ({ role, content: text });

  const first = makeApi(validConfig({ autoRecall: false, bufferLimit: 5 }), stateDir);
  register(first.api);
  // The run ended on a user message with no assistant reply, then the gateway stopped.
  first.hooks.get("agent_end")({ success: false, messages: [message("user", "u1")] }, ctx);
  await first.hooks.get("gateway_stop")();

  const second = makeApi(validConfig({ autoRecall: false, bufferLimit: 5 }), stateDir);
  register(second.api);
  // OpenClaw replays the whole transcript snapshot for the resumed session.
  second.hooks.get("agent_end")(
    {
      success: true,
      messages: [
        message("user", "u1"),
        message("user", "u2"),
        message("assistant", "a2"),
        message("user", "u3"),
        message("assistant", "a3"),
      ],
    },
    ctx,
  );
  await waitFor(() => toolCalls.some((call) => call.name === "add_memory"));
  await second.hooks.get("gateway_stop")();

  const captured = toolCalls
    .filter((call) => call.name === "add_memory")
    .flatMap((call) => JSON.parse(call.arguments.episode_body).messages.map((m) => m.text));
  assert.deepEqual(captured, ["u1", "u2", "a2", "u3", "a3"], "every message exactly once, in order");
});

/** Leave one submitted-but-unanswered batch in the durable spool, like a stop mid-request. */
async function spoolUnansweredBatch(t, stateDir) {
  const calls = makeFetchRecorder(t, { failAddMemory: true });
  const { hooks } = registerRuntime(stateDir);
  hooks.get("agent_end")(completedTurn(1), restartCtx);
  hooks.get("agent_end")(completedTurn(2), restartCtx);
  await waitFor(() => calls.some((call) => call.name === "add_memory"));
  await hooks.get("gateway_stop")();
  return calls.find((call) => call.name === "add_memory").arguments;
}

const restartSessionKey = "agent:main:web:1d8d5bfd-de0e-4877-82cb-6bc2a77c6957";
const restartCtx = { agentId: "main", sessionKey: restartSessionKey, trigger: "user" };

function registerRuntime(stateDir) {
  const runtime = makeApi(validConfig({ autoRecall: false, bufferLimit: 4 }), stateDir);
  register(runtime.api);
  return runtime;
}

test("a batch Graphiti already persisted is never submitted a second time", async (t) => {
  const stateDir = join(runtimeStateRoot, "reconcile-persisted");
  const submitted = await spoolUnansweredBatch(t, stateDir);

  // The request did reach Graphiti before the stop: the saga now ends on that uuid.
  const calls = makeFetchRecorder(t, {
    sagaState: { episodeCount: 1, lastEpisodeUuid: submitted.uuid },
  });
  const { hooks, logs } = registerRuntime(stateDir);
  await waitFor(() => logs.some((line) => line.includes("event=capture_replay_already_persisted")));

  assert.deepEqual(
    calls.filter((call) => call.name === "add_memory"),
    [],
    "a confirmed batch is dropped instead of duplicated",
  );

  // The chain continues from the confirmed episode as batch 2.
  hooks.get("agent_end")(completedTurn(3), restartCtx);
  hooks.get("agent_end")(completedTurn(4), restartCtx);
  await waitFor(() => calls.some((call) => call.name === "add_memory"));
  const next = calls.find((call) => call.name === "add_memory").arguments;
  assert.equal(next.name, "6bc2a77c6957-2");
  assert.equal(next.saga_previous_episode_uuid, submitted.uuid);
  await hooks.get("gateway_stop")();
});

test("an unconfirmed batch is replayed with its reserved episode identity", async (t) => {
  const stateDir = join(runtimeStateRoot, "reconcile-unconfirmed");
  const submitted = await spoolUnansweredBatch(t, stateDir);

  // The request never reached Graphiti: the saga does not exist at all.
  const calls = makeFetchRecorder(t);
  const { hooks, logs } = registerRuntime(stateDir);
  await waitFor(() => calls.some((call) => call.name === "add_memory"));

  const replay = calls.find((call) => call.name === "add_memory").arguments;
  assert.equal(replay.uuid, submitted.uuid, "the reserved UUID survives the restart");
  assert.equal(replay.name, submitted.name);
  assert.equal(replay.saga_previous_episode_uuid, submitted.saga_previous_episode_uuid);
  assert.deepEqual(
    JSON.parse(replay.episode_body).messages,
    JSON.parse(submitted.episode_body).messages,
  );
  assert.ok(logs.some((line) => line.includes("event=capture_replay_reserved_identity")));
  await hooks.get("gateway_stop")();
});

test("capture strips Graphiti and OpenViking injections from message deltas", () => {
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

  const captureLog = logs.find((record) => record.includes("event=capture_messages"));
  assert.ok(captureLog);
  assert.match(captureLog, /alpha/);
  assert.match(captureLog, /beta/);
  assert.doesNotMatch(captureLog, /viking injection/);
  assert.doesNotMatch(captureLog, /graphiti injection/);
});

test("heartbeat, cron and subagent sessions are excluded by the default patterns", () => {
  const { hooks, logs, api } = makeApi(validConfig({ autoRecall: false, logLevel: "debug" }));
  register(api);

  const blocked = [
    { sessionKey: "agent:main:heartbeat:hidden", trigger: "user" },
    { sessionKey: "agent:main:subagent:worker", trigger: "user" },
    { sessionKey: "agent:main:cron:job", trigger: "user" },
    { sessionKey: "agent:main:web:normal", trigger: "heartbeat" },
    { sessionKey: "agent:main:web:normal", trigger: "cron" },
  ];
  blocked.forEach((ctx, index) => {
    hooks.get("agent_end")(completedTurn(index + 1), { agentId: "main", ...ctx });
  });

  assert.equal(logs.filter((line) => line.includes('reason="excluded_session"')).length, blocked.length);
  assert.equal(logs.some((line) => line.includes("event=capture_messages")), false);
});

test("agent_end with no assistant reply keeps the user message in capture", () => {
  const { hooks, logs, api } = makeApi(validConfig({ autoRecall: false, logLevel: "debug", logContent: true }));
  register(api);

  hooks.get("agent_end")(
    { success: true, messages: [{ role: "user", content: "hello без ответа" }] },
    { agentId: "main", sessionKey: "agent:main:web:conversation-a", trigger: "user" },
  );

  const captureLog = logs.find((record) => record.includes("event=capture_messages"));
  assert.ok(captureLog);
  assert.match(captureLog, /hello без ответа/);
  assert.match(captureLog, /userMessages=1/);
  assert.match(captureLog, /assistantMessages=0/);
});

test("aborted agent_end still captures a new user message", async (t) => {
  const toolCalls = makeFetchRecorder(t);
  const { hooks, logs, api } = makeApi(
    validConfig({ autoRecall: false, bufferLimit: 1, logLevel: "debug", logContent: true }),
  );
  register(api);

  hooks.get("agent_end")(
    {
      success: false,
      error: "AbortError",
      messages: [{ role: "user", content: "сообщение после остановки" }],
    },
    { agentId: "main", sessionKey: "agent:main:web:aborted", trigger: "user" },
  );

  await waitFor(() => toolCalls.some((call) => call.name === "add_memory"));
  const add = toolCalls.find((call) => call.name === "add_memory").arguments;
  const body = JSON.parse(add.episode_body);
  assert.deepEqual(body.messages, [{ role: "user", text: "сообщение после остановки" }]);
  assert.ok(logs.some((record) => record.includes("event=capture_messages") && record.includes("eventSuccess=false")));
});

test("invalid agents config is rejected at plugin load", (t) => {
  makeFetchRecorder(t);
  const { api } = makeApi(validConfig({ agents: { main: { user: "Вит" } } }));
  assert.throws(() => register(api), /assistant/);
});

test("two restored batches of one session reconcile without resetting the sequence", async (t) => {
  const stateDir = join(runtimeStateRoot, "reconcile-two-entries");
  const failing = makeFetchRecorder(t, { failAddMemory: true });
  const first = makeApi(validConfig({ autoRecall: false, bufferLimit: 2 }), stateDir);
  register(first.api);

  // Two batches detach while delivery keeps failing, so both are spooled.
  first.hooks.get("agent_end")(completedTurn(1), restartCtx);
  first.hooks.get("agent_end")(completedTurn(2), restartCtx);
  await waitFor(() => failing.some((call) => call.name === "add_memory"));
  await first.hooks.get("gateway_stop")();

  const calls = makeFetchRecorder(t);
  const second = makeApi(validConfig({ autoRecall: false, bufferLimit: 2 }), stateDir);
  register(second.api);
  await waitFor(() => calls.filter((call) => call.name === "add_memory").length === 2);
  await second.hooks.get("gateway_stop")();

  const adds = calls.filter((call) => call.name === "add_memory").map((call) => call.arguments);
  assert.deepEqual(
    adds.map((add) => add.name),
    ["6bc2a77c6957-1", "6bc2a77c6957-2"],
    "batch numbering continues instead of restarting",
  );
  assert.equal(adds[1].saga_previous_episode_uuid, adds[0].uuid, "the chain stays linked");
  assert.equal(calls.filter((call) => call.name === "get_saga").length, 1, "one reconciliation per session");
});
