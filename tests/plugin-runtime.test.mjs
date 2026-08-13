import test from "node:test";
import assert from "node:assert/strict";
import { register } from "../dist/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail("condition was not met before timeout");
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

test("runtime sanitizes capture and recall while routing by ctx.agentId", async (t) => {
  const originalFetch = globalThis.fetch;
  const toolCalls = [];
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

  const hooks = new Map();
  const logs = [];
  const api = {
    pluginConfig: {
      captureBatchTurns: 1,
      captureBatchIdleFlushSeconds: 300,
      logLevel: "debug",
      logContent: true,
    },
    logger: {
      debug: (message) => logs.push({ level: "debug", message }),
      info: (message) => logs.push({ level: "info", message }),
      warn: (message) => logs.push({ level: "warn", message }),
      error: (message) => logs.push({ level: "error", message }),
    },
    on: (name, handler) => hooks.set(name, handler),
  };

  register(api);
  assert.ok(hooks.has("agent_end"));
  assert.ok(hooks.has("before_prompt_build"));

  hooks.get("agent_end")(
    {
      success: true,
      messages: [
        {
          role: "user",
          content: "alpha <relevant-memories>viking injection</relevant-memories>",
        },
        {
          role: "assistant",
          content: "beta <graphiti-context>graphiti injection</graphiti-context>",
        },
      ],
    },
    { agentId: "main", sessionKey: "agent:main:web:conversation-a", trigger: "user" },
  );

  await waitFor(() => toolCalls.some((call) => call.name === "add_memory"));
  const addCall = toolCalls.find((call) => call.name === "add_memory");
  assert.equal(addCall.arguments.group_id, "main");
  assert.match(addCall.arguments.episode_body, /alpha/);
  assert.match(addCall.arguments.episode_body, /beta/);
  assert.doesNotMatch(addCall.arguments.episode_body, /viking injection/);
  assert.doesNotMatch(addCall.arguments.episode_body, /graphiti injection/);
  assert.equal("uuid" in addCall.arguments, false);

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

  const captureLog = logs.find((record) => record.message.includes("event=capture_payload"));
  const recallLog = logs.find((record) => record.message.includes("event=recall_payload"));
  assert.ok(captureLog);
  assert.ok(recallLog);
  assert.doesNotMatch(captureLog.message, /viking injection/);
  assert.doesNotMatch(captureLog.message, /graphiti injection/);
});
