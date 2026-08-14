import test from "node:test";
import assert from "node:assert/strict";
import { register } from "../dist/index.js";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function makeFetchRecorder(t) {
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
    if (payload.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (payload.method !== "tools/call") throw new Error(`unexpected method ${payload.method}`);
    toolCalls.push(payload.params);
    if (payload.params.name === "add_memory") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: { structuredContent: { message: "queued" }, content: [], isError: false },
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
  // v0.2: bufferLimit >= 30, bufferTimeout >= 30000 (минимальные валидные значения).
  bufferLimit: 30,
  bufferTimeout: 30_000,
  participants: [
    { role: "user", name: "Вит", aliases: ["Виктор"] },
    { role: "assistant", name: "Краб", aliases: ["Крабушек"] },
  ],
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

test("runtime registers agent_end and before_prompt_build, recall routes by ctx.agentId", async (t) => {
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
  assert.ok(searchCall);
  assert.equal(searchCall.arguments.group_ids, "main");
  assert.doesNotMatch(searchCall.arguments.query, /hidden recall input/);

  assert.ok(recallResult?.prependContext);
  assert.match(recallResult.prependContext, /^<graphiti-context>/);
  assert.match(recallResult.prependContext, /Viktor uses Graphiti/);
  assert.match(recallResult.prependContext, /&lt;\/graphiti-context&gt;/);
  assert.equal((recallResult.prependContext.match(/<\/graphiti-context>/g) ?? []).length, 1);
});

test("agent_end route buffers a completed turn and logs capture_turn", async (t) => {
  makeFetchRecorder(t);
  const { hooks, logs, api } = makeApi(validConfig({ logLevel: "debug", logContent: true }));

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

  // Хук отработал синхронно: буфер наполнен (лог capture_turn), инъекции вырезаны.
  const turnLog = logs.find((record) => record.includes("event=capture_turn"));
  assert.ok(turnLog, "capture_turn log emitted");
  assert.doesNotMatch(turnLog, /viking injection/);
  assert.doesNotMatch(turnLog, /graphiti injection/);
});

test("agent_end with no assistant reply publishes nothing", async (t) => {
  makeFetchRecorder(t);
  const { hooks, logs, api } = makeApi(validConfig({ logLevel: "debug" }));

  register(api);

  // Только user-сообщение, без ответа ассистента → extractCompletedTurn=null → skip.
  hooks.get("agent_end")(
    { success: true, messages: [{ role: "user", content: "hello без ответа" }] },
    { agentId: "main", sessionKey: "agent:main:web:conversation-a", trigger: "user" },
  );

  const skipped = logs.find((record) => record.includes("no_completed_turn"));
  assert.ok(skipped, "no_completed_turn should be logged");
  const turnLog = logs.find((record) => record.includes("event=capture_turn"));
  assert.equal(turnLog, undefined, "nothing added to buffer without assistant reply");
});

test("invalid participants config is rejected at plugin load", async (t) => {
  makeFetchRecorder(t);
  const { api } = makeApi(
    validConfig({
      participants: [
        { role: "user", name: "Вит" },
        { role: "user", name: "Другой" },
      ],
    }),
  );

  assert.throws(() => register(api), /duplicate participant role/);
});
