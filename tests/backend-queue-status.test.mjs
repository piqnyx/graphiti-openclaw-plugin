import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphitiMcpClient } from "../dist/mcp-client.js";
import { register } from "../dist/index.js";
import { resetCaptureRuntimeForTests } from "../dist/capture-runtime.js";

function isolateStateDir(t) {
  const stateDir = mkdtempSync(join(tmpdir(), "graphiti-backend-status-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
}

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
    await sleep(10);
  }
  assert.fail("condition was not met before timeout");
}

test("getQueueStatus maps terminal backend failure metadata", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    if (payload.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18" } });
    }
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
    assert.equal(payload.params.name, "get_queue_status");
    assert.deepEqual(payload.params.arguments, { group_id: "main" });
    return jsonResponse({
      jsonrpc: "2.0",
      id: payload.id,
      result: {
        structuredContent: {
          result: {
            message: "retrieved",
            group_id: "main",
            blocked: true,
            attempts: 5,
            last_error: "provider timeout",
            pending: 2,
            episode_uuid: "episode-7",
            episode_name: "6bc2a77c6957-7",
            saga: "agent:main:web:session-1",
          },
        },
        content: [],
        isError: false,
      },
    });
  };

  const client = new GraphitiMcpClient("http://127.0.0.1:8000/mcp/", 1000);
  assert.deepEqual(await client.getQueueStatus("main"), {
    groupId: "main",
    blocked: true,
    attempts: 5,
    pending: 2,
    queuedEpisodeUuids: [],
    lastError: "provider timeout",
    episodeUuid: "episode-7",
    episodeName: "6bc2a77c6957-7",
    saga: "agent:main:web:session-1",
  });
});

test("backend poll publishes errors only to the failed saga session", async (t) => {
  resetCaptureRuntimeForTests();
  isolateStateDir(t);
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = [];
  const patches = [];
  const entries = new Map();
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
    resetCaptureRuntimeForTests();
  });

  globalThis.setInterval = (fn, ms) => {
    intervals.push({ fn, ms });
    return { unref() {} };
  };

  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    if (payload.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18" } });
    }
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (payload.params.name === "get_queue_status") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          structuredContent: {
            result: {
              group_id: "main",
              blocked: true,
              attempts: 5,
              last_error: "deepseek failed permanently",
              pending: 3,
              episode_uuid: "episode-7",
              episode_name: "6bc2a77c6957-7",
              saga: "agent:main:web:failed-saga",
              queued_episode_uuids: [],
            },
          },
          content: [],
          isError: false,
        },
      });
    }
    throw new Error(`unexpected tool ${payload.params.name}`);
  };

  const hooks = new Map();
  const api = {
    pluginConfig: {
      autoCapture: true,
      autoRecall: false,
      bufferLimit: 6,
      bufferTimeout: 300,
      agents: { main: { user: "Вит", assistant: "Краб" } },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on: (name, handler) => hooks.set(name, handler),
    session: {
      state: { registerSessionExtension() {} },
      controls: { registerControlUiDescriptor() {} },
    },
    runtime: {
      agent: {
        session: {
          patchSessionEntry: async ({ agentId, sessionKey, update }) => {
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
  };

  register(api);
  assert.equal(intervals.length, 2, "durable capture ticker plus backend queue health ticker");
  assert.equal(intervals[1].ms, 30_000);

  intervals[1].fn();
  await waitFor(() => patches.length === 1);

  assert.equal(patches[0].sessionKey, "agent:main:web:failed-saga");
  const status = patches[0].entry.pluginExtensions["graphiti-openclaw-plugin"]["backend-queue-status"];
  assert.equal(status.status, "error");
  assert.equal(status.source, "backend_queue");
  assert.equal(status.attempts, 5);
  assert.equal(status.pending, 3);
  assert.equal(status.episodeUuid, "episode-7");
  assert.match(status.error, /deepseek failed permanently/);
});
