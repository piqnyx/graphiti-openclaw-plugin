import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "../dist/index.js";
import { resolveCaptureSpoolPath } from "../dist/capture-spool.js";

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
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** Drive the plugin through one captured turn and return what it sent. */
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
      return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18" } });
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
    pluginConfig: { autoCapture: true, autoRecall: false, bufferLimit: 2, logLevel: "debug",
      agents: { main: { user: "Вит", assistant: "Краб" } } },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on: (event, handler) => hooks.set(event, handler),
    registerTool: () => {},
  });
  return { calls, hooks };
}

// The hook takes the event and the invocation context separately, and the
// event carries the full transcript rather than a delta.
const turn = (hooks) =>
  hooks.get("agent_end")(
    {
      success: true,
      messages: [
        { role: "user", content: "привет" },
        { role: "assistant", content: "здравствуй" },
      ],
    },
    { agentId: "main", sessionKey: "agent:main:telegram:1", trigger: "user" },
  );

test("an accepted batch stays on the ledger until the episode is seen in the graph", async (t) => {
  let episodeExists = false;
  const { calls, hooks } = harness(t, {
    get_saga: () => ({ error: "No saga named 'agent:main:telegram:1' found in group 'main'" }),
    add_memory: (args) => ({ message: "queued", uuid: args.uuid }),
    get_queue_status: () => ({ group_id: "main", blocked: false, attempts: 0, pending: 0 }),
    // The episode is absent at first: Graphiti took the batch but has not
    // extracted it yet, which is the state acceptance used to hide.
    get_episodes_by_ref: () => ({ episodes: episodeExists ? [{ uuid: submittedUuid, name: "1-1" }] : [] }),
  });

  await turn(hooks);
  await waitFor(() => calls.some((c) => c.name === "add_memory"), "the batch to be submitted");
  const submittedUuid = calls.find((c) => c.name === "add_memory").arguments.uuid;

  const spool = JSON.parse(readFileSync(resolveCaptureSpoolPath(), "utf8"));
  assert.equal(spool.pending.length, 1, "an accepted batch must remain outstanding");
  assert.equal(spool.pending[0].uuid, submittedUuid);
  assert.ok(spool.pending[0].episodeBody.includes("привет"), "the body must be kept for a resubmission");
  episodeExists = true;
});

test("the ledger keeps everything needed to resubmit the batch unchanged", async (t) => {
  const { calls, hooks } = harness(t, {
    get_saga: () => ({ error: "No saga named 'agent:main:telegram:1' found in group 'main'" }),
    add_memory: (args) => ({ message: "queued", uuid: args.uuid }),
    get_queue_status: () => ({ group_id: "main", blocked: false, attempts: 0, pending: 0 }),
    get_episodes_by_ref: () => ({ episodes: [] }),
  });

  await turn(hooks);
  await waitFor(() => calls.some((c) => c.name === "add_memory"), "the batch to be submitted");

  const sent = calls.find((c) => c.name === "add_memory").arguments;
  const pending = JSON.parse(readFileSync(resolveCaptureSpoolPath(), "utf8")).pending[0];
  // Regenerating any of these on retry would move the episode in the dialog's
  // timeline or break its chain, so they are stored rather than recomputed.
  assert.equal(pending.referenceTime, sent.reference_time);
  assert.equal(pending.name, sent.name);
  assert.deepEqual(pending.previousEpisodeUuids, sent.previous_episode_uuids);
});
