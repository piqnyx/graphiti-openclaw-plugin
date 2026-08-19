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

function completedTranscript(turns) {
  return {
    success: true,
    messages: Array.from({ length: turns }, (_, index) => completedTurn(index + 1).messages).flat(),
  };
}

function installDefinitiveGraphitiFailure(t) {
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
        { headers: { "Mcp-Session-Id": "ui-status-test" } },
      );
    }
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (payload.method !== "tools/call") throw new Error(`unexpected method ${payload.method}`);

    let result;
    if (payload.params.name === "get_saga") {
      const sagaName = payload.params.arguments.saga_name;
      const groupId = payload.params.arguments.group_id;
      result = { error: `No saga named '${sagaName}' found in group '${groupId}'` };
    } else if (payload.params.name === "add_memory") {
      result = { error: "simulated definitive Graphiti rejection" };
    } else {
      throw new Error(`unexpected tool ${payload.params.name}`);
    }

    return jsonResponse({
      jsonrpc: "2.0",
      id: payload.id,
      result: { structuredContent: { result }, content: [], isError: false },
    });
  };
}

function makeApi(t, { patchThrows = false } = {}) {
  resetCaptureRuntimeForTests();
  const stateDir = mkdtempSync(join(tmpdir(), "graphiti-ui-status-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;

  const hooks = new Map();
  const logs = [];
  const extensions = [];
  const descriptors = [];
  const patches = [];
  const entries = new Map();

  t.after(async () => {
    const stop = hooks.get("gateway_stop");
    if (stop) await stop();
    resetCaptureRuntimeForTests();
    rmSync(stateDir, { recursive: true, force: true });
  });

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
        agentDbPath: agentStore.agentDbPath,
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
        state: { registerSessionExtension: (extension) => extensions.push(extension) },
        controls: { registerControlUiDescriptor: (descriptor) => descriptors.push(descriptor) },
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

test("definitive capture failures publish error-only plugin session status", async (t) => {
  installDefinitiveGraphitiFailure(t);
  const { hooks, extensions, descriptors, patches, api } = makeApi(t);
  register(api);

  assert.equal(extensions.length, 2);
  assert.equal(extensions[0].namespace, "capture-status");
  assert.equal(extensions[1].namespace, "backend-queue-status");
  assert.equal(descriptors.length, 2);
  assert.equal(descriptors[0].id, "capture-error");
  assert.equal(descriptors[1].id, "backend-queue-error");

  const sessionKey = "agent:main:web:status-test";
  const ctx = { agentId: "main", sessionKey, trigger: "user" };
  agentEnd({ hooks }, completedTurn(1), ctx);
  agentEnd({ hooks }, completedTranscript(2), ctx);

  // Looking for the patch that carries the capture status, not for a patch count:
  // the backend-queue namespace publishes through the same channel, and counting
  // them makes the test fail on an unrelated report arriving first.
  const captureStatus = () =>
    patches
      .map((patch) => patch.entry.pluginExtensions?.["graphiti-openclaw-plugin"]?.["capture-status"])
      .find((value) => value?.status === "error");
  await waitFor(() => captureStatus() !== undefined);
  const status = captureStatus();
  assert.equal(status.status, "error");
  assert.equal(status.reason, "limit");
  assert.equal(status.retryIntervalSeconds, 30);
  assert.match(status.message, /retained for automatic retry/);
  assert.match(status.error, /definitive Graphiti rejection/);
});

test("session status write failures never escape into capture control flow", async (t) => {
  installDefinitiveGraphitiFailure(t);
  const { hooks, logs, api } = makeApi(t, { patchThrows: true });
  register(api);

  const ctx = { agentId: "main", sessionKey: "agent:main:web:status-failure", trigger: "user" };
  agentEnd({ hooks }, completedTurn(1), ctx);
  agentEnd({ hooks }, completedTranscript(2), ctx);

  await waitFor(() => logs.some((line) => line.includes("event=capture_ui_status_failed")));
  assert.ok(logs.some((line) => line.includes("event=capture_flush_failed")));
  assert.ok(logs.some((line) => line.includes("action=\"publish_error\"")));
});
