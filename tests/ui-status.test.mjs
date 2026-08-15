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

function completedTurn(n) {
  return {
    success: true,
    messages: [
      { role: "user", content: `user-${n}` },
      { role: "assistant", content: `assistant-${n}` },
    ],
  };
}

function installFailingGraphitiFetch(t) {
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
        { headers: { "Mcp-Session-Id": "ui-status-test" } },
      );
    }
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (payload.method !== "tools/call") throw new Error(`unexpected method ${payload.method}`);
    if (payload.params.name === "get_saga") {
      const sagaName = payload.params.arguments.saga_name;
      const groupId = payload.params.arguments.group_id;
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          structuredContent: {
            result: { error: `No saga named '${sagaName}' found in group '${groupId}'` },
          },
          content: [],
          isError: false,
        },
      });
    }
    if (payload.params.name === "add_memory") {
      throw new Error("simulated Graphiti transport failure");
    }
    throw new Error(`unexpected tool ${payload.params.name}`);
  };
}

function makeApi({ patchThrows = false } = {}) {
  const hooks = new Map();
  const logs = [];
  const extensions = [];
  const descriptors = [];
  const patches = [];
  const entries = new Map();

  return {
    hooks,
    logs,
    extensions,
    descriptors,
    patches,
    api: {
      pluginConfig: {
        autoRecall: false,
        bufferLimit: 4,
        bufferTimeout: 30,
        agents: { main: { user: "Вит", assistant: "Краб" } },
      },
      logger: {
        debug: (message) => logs.push(message),
        info: (message) => logs.push(message),
        warn: (message) => logs.push(message),
        error: (message) => logs.push(message),
      },
      on: (name, handler) => hooks.set(name, handler),
      session: {
        state: {
          registerSessionExtension: (extension) => extensions.push(extension),
        },
        controls: {
          registerControlUiDescriptor: (descriptor) => descriptors.push(descriptor),
        },
      },
      runtime: {
        agent: {
          session: {
            patchSessionEntry: async ({ agentId, sessionKey, update }) => {
              if (patchThrows) throw new Error("simulated session status failure");
              const key = `${agentId}/${sessionKey}`;
              const entry = entries.get(key) ?? {};
              const patch = update(entry);
              if (patch) Object.assign(entry, patch);
              entries.set(key, entry);
              patches.push({ agentId, sessionKey, entry: structuredClone(entry) });
              return entry;
            },
          },
        },
      },
    },
  };
}

test("capture failures publish error-only plugin session status", async (t) => {
  installFailingGraphitiFetch(t);
  const { hooks, extensions, descriptors, patches, api } = makeApi();
  register(api);

  assert.equal(extensions.length, 1);
  assert.equal(extensions[0].namespace, "capture-status");
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].id, "capture-error");
  assert.equal(descriptors[0].surface, "session");

  const sessionKey = "agent:main:web:status-test";
  const ctx = { agentId: "main", sessionKey, trigger: "user" };
  hooks.get("agent_end")(completedTurn(1), ctx);
  hooks.get("agent_end")(completedTurn(2), ctx);

  await waitFor(() => patches.length === 1);
  const status = patches[0].entry.pluginExtensions["graphiti-openclaw-plugin"]["capture-status"];
  assert.equal(status.status, "error");
  assert.equal(status.reason, "limit");
  assert.equal(status.retryIntervalSeconds, 30);
  assert.match(status.message, /retained for automatic retry/);
  assert.match(status.error, /simulated Graphiti transport failure/);
});

test("session status write failures never escape into capture control flow", async (t) => {
  installFailingGraphitiFetch(t);
  const { hooks, logs, api } = makeApi({ patchThrows: true });
  register(api);

  const ctx = { agentId: "main", sessionKey: "agent:main:web:status-failure", trigger: "user" };
  hooks.get("agent_end")(completedTurn(1), ctx);
  hooks.get("agent_end")(completedTurn(2), ctx);

  await waitFor(() => logs.some((line) => line.includes("event=capture_ui_status_failed")));
  assert.ok(logs.some((line) => line.includes("event=capture_flush_failed")));
  assert.ok(logs.some((line) => line.includes("action=\"publish_error\"")));
});
