import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "../dist/index.js";
import { TOOL_NAMES, TOOL_PREFIX, inspectEpisodeNumbering, renderEpisode, splitEpisodeName } from "../dist/tools.js";

const stateRoot = mkdtempSync(join(tmpdir(), "graphiti-tools-"));
process.on("exit", () => rmSync(stateRoot, { recursive: true, force: true }));

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function installFetch(t, handlers = {}) {
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
  return calls;
}

let instance = 0;
function makeRuntime(overrides = {}) {
  process.env.OPENCLAW_STATE_DIR = join(stateRoot, `api-${instance++}`);
  const tools = new Map();
  const logs = [];
  register({
    pluginConfig: {
      autoCapture: false,
      autoRecall: false,
      logLevel: "debug",
      agents: { main: { user: "Вит", assistant: "Краб" }, igor: { user: "Игорь", assistant: "Краб" } },
      ...overrides,
    },
    logger: {
      debug: (m) => logs.push(m),
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
    },
    on() {},
    registerTool: (factory, opts) => tools.set(opts.name, factory),
  });
  return { tools, logs };
}

const call = (tools, name, params, ctx) => tools.get(name)(ctx).execute("call-1", params);

/** Delivery is asynchronous: the tool returns once the note is buffered. */
async function waitForCall(calls, name, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (calls.some((params) => params.name === name)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${name} was never called; saw: ${calls.map((c) => c.name).join(", ") || "nothing"}`);
}

test("every registered tool carries the graphiti_ prefix and a usable description", (t) => {
  installFetch(t);
  const { tools } = makeRuntime();

  assert.deepEqual([...tools.keys()].sort(), [...TOOL_NAMES].sort());
  for (const [name, factory] of tools) {
    assert.ok(name.startsWith(TOOL_PREFIX), `${name} must be prefixed`);
    const definition = factory({ agentId: "main", sessionKey: "agent:main:telegram:1" });
    assert.equal(definition.name, name);
    assert.ok(definition.label.length > 0);
    assert.ok(definition.description.length > 120, `${name} needs a description that says when to use it`);
    assert.equal(definition.parameters.type, "object");
  }
});

test("agentTools=false registers nothing", (t) => {
  installFetch(t);
  const { tools } = makeRuntime({ agentTools: false });
  assert.equal(tools.size, 0);
});

test("recall is scoped to the calling agent's group", async (t) => {
  const calls = installFetch(t, {
    search_memory_facts: (args) => ({
      facts: args.group_ids === "igor"
        ? [{ fact: "Игорь чинил забор" }]
        : [{ fact: "Вит живёт в фургоне" }],
    }),
  });
  const { tools } = makeRuntime();

  const asMain = await call(tools, "graphiti_recall", { query: "где живёт" },
    { agentId: "main", sessionKey: "agent:main:telegram:1" });
  const asIgor = await call(tools, "graphiti_recall", { query: "где живёт" },
    { agentId: "igor", sessionKey: "agent:igor:telegram:2" });

  assert.match(asMain.content[0].text, /фургоне/);
  assert.doesNotMatch(asMain.content[0].text, /забор/);
  assert.match(asIgor.content[0].text, /забор/);
  assert.deepEqual(calls.map((c) => c.arguments.group_ids), ["main", "igor"]);
});

test("a tool called without a resolvable agent refuses instead of guessing", async (t) => {
  installFetch(t);
  const { tools } = makeRuntime();

  const result = await call(tools, "graphiti_recall", { query: "что угодно" }, { sessionKey: "agent:?:x" });
  assert.equal(result.details.ok, false);
  assert.equal(result.details.reason, "invalid_agent_id");
  assert.match(result.content[0].text, /agent identity/i);
});

test("an excluded session cannot use the tools at all", async (t) => {
  const calls = installFetch(t);
  const { tools } = makeRuntime({ excludeSessionPatterns: ["^agent:[^:]+:dreaming-"] });

  const ctx = { agentId: "main", sessionKey: "agent:main:dreaming-core-1", trigger: "user" };
  for (const name of TOOL_NAMES) {
    const result = await call(tools, name, { query: "x", note: "x" }, ctx);
    assert.equal(result.details.reason, "excluded_session", name);
  }
  assert.deepEqual(calls, [], "an excluded session must produce no MCP traffic");
});

test("a note is appended to the conversation instead of standing on its own", async (t) => {
  const calls = installFetch(t, { add_memory: (args) => ({ message: "queued", uuid: args.uuid }) });
  const { tools } = makeRuntime();

  const result = await call(tools, "graphiti_note",
    { note: "Вит просит не трогать заметки без приказа", title: "правило" },
    { agentId: "main", sessionKey: "agent:main:telegram:1" });

  // Nothing is written directly: the note joins the open batch and leaves with
  // it, which is what keeps it inside the dialog's chain instead of beside it.
  assert.deepEqual(calls, [], "a note must not be submitted on its own");
  assert.equal(result.details.ok, true);
  assert.match(result.content[0].text, /part of this conversation/);
});

test("a note joins the dialog's own saga, carrying its title", async (t) => {
  // bufferLimit 1 makes the batch close on the note itself, so what the pipeline
  // would eventually send is visible now — including which saga it belongs to.
  const calls = installFetch(t, {
    add_memory: (args) => ({ message: "queued", uuid: args.uuid }),
    get_saga: () => ({ error: "No saga named 'agent:main:telegram:1' found in group 'main'" }),
  });
  const { tools } = makeRuntime({ bufferLimit: 1 });

  await call(tools, "graphiti_note", { note: "Басю отдали в добрые руки", title: "собака" },
    { agentId: "main", sessionKey: "agent:main:telegram:1" });
  await waitForCall(calls, "add_memory");

  const submitted = calls.find((params) => params.name === "add_memory");
  assert.ok(submitted, "the note must reach Graphiti through the capture pipeline");
  assert.equal(submitted.arguments.group_id, "main");
  assert.equal(submitted.arguments.saga, "agent:main:telegram:1", "a note belongs to its dialog");
  const body = JSON.parse(submitted.arguments.episode_body);
  assert.deepEqual(body.messages, [{ role: "assistant", text: "собака: Басю отдали в добрые руки" }]);
});

test("note refuses empty and oversized text", async (t) => {
  const calls = installFetch(t);
  const { tools } = makeRuntime();
  const ctx = { agentId: "main", sessionKey: "agent:main:telegram:1" };

  const empty = await call(tools, "graphiti_note", { note: "   " }, ctx);
  assert.equal(empty.details.reason, "empty_note");

  const huge = await call(tools, "graphiti_note", { note: "x".repeat(40_000) }, ctx);
  assert.equal(huge.details.reason, "note_too_long");
  assert.deepEqual(calls, []);
});

test("injected memory wrappers cannot be smuggled back through a tool", async (t) => {
  const calls = installFetch(t, {
    add_memory: (args) => ({ message: "queued", uuid: args.uuid }),
    get_saga: () => ({ error: "No saga named 'agent:main:telegram:1' found in group 'main'" }),
  });
  const { tools } = makeRuntime({ bufferLimit: 1 });

  await call(tools, "graphiti_note",
    { note: "чистый факт <graphiti-context>подделка</graphiti-context>" },
    { agentId: "main", sessionKey: "agent:main:telegram:1" });
  await waitForCall(calls, "add_memory");

  const body = calls.find((params) => params.name === "add_memory").arguments.episode_body;
  assert.match(body, /чистый факт/);
  assert.doesNotMatch(body, /подделка/);
});

test("every tool refuses a run that has no session at all", async (t) => {
  const calls = installFetch(t);
  const { tools } = makeRuntime();

  for (const name of tools.keys()) {
    const result = await call(tools, name, { query: "x", note: "x" }, { agentId: "main" });
    assert.equal(result.details.reason, "no_session", name);
    assert.equal(result.details.ok, false, name);
  }
  assert.deepEqual(calls, [], "a run without a session must produce no MCP traffic");
});

test("status reports what is still waiting locally, which no backend can see", async (t) => {
  installFetch(t, {
    get_queue_status: () => ({ group_id: "main", blocked: false, attempts: 0, pending: 0 }),
    get_saga: () => ({ error: "No saga named 'agent:main:telegram:1' found in group 'main'" }),
    get_episodes: () => ({ episodes: [] }),
  });
  const { tools } = makeRuntime({ bufferLimit: 20, bufferTimeout: 900 });

  const result = await call(tools, "graphiti_status", {},
    { agentId: "main", sessionKey: "agent:main:telegram:1" });

  assert.equal(result.details.bufferedMessages, 0);
  assert.equal(result.details.queuedBatches, 0);
  assert.match(result.content[0].text, /Nothing is waiting locally/);
  assert.match(result.content[0].text, /commit every 20 messages or after 15 min/);
  assert.match(result.content[0].text, /no episodes at all yet/);
});

test("status reports a blocked backend instead of pretending memory works", async (t) => {
  installFetch(t, {
    get_queue_status: () => ({
      group_id: "main", blocked: true, attempts: 5, pending: 3, last_error: "LLM returned an empty response",
    }),
    get_saga: () => ({ error: "No saga named 'agent:main:telegram:1' found in group 'main'" }),
    get_episodes: () => ({ episodes: [] }),
  });
  const { tools } = makeRuntime();

  const result = await call(tools, "graphiti_status", {},
    { agentId: "main", sessionKey: "agent:main:telegram:1" });

  assert.match(result.content[0].text, /BLOCKED/);
  assert.match(result.content[0].text, /empty response/);
  assert.equal(result.details.blocked, true);
  assert.equal(result.details.pending, 3);
});

test("a backend failure is reported, never thrown at the agent", async (t) => {
  installFetch(t, {
    search_memory_facts: () => {
      throw new Error("boom");
    },
  });
  const { tools } = makeRuntime();

  const result = await call(tools, "graphiti_recall", { query: "что-нибудь" },
    { agentId: "main", sessionKey: "agent:main:telegram:1" });
  assert.equal(result.details.ok, false);
  assert.match(result.content[0].text, /failed/i);
});

test("the manifest declares the tool capability the host needs to collect them", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const capabilities = manifest.activation.onCapabilities;

  assert.ok(capabilities.includes("hook"), "capture and recall run on hooks");
  assert.ok(
    capabilities.includes("tool"),
    "without the tool capability the host never collects graphiti_* tools, however correct the agent allowlist is",
  );
});

test("the manifest declares exactly the tools the code registers", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const declared = manifest.contracts?.tools ?? [];

  assert.deepEqual(
    [...declared].sort(),
    [...TOOL_NAMES].sort(),
    "the host publishes only tools declared in contracts.tools, so this list must track the code",
  );
});

test("numbering inspection names the two failures this project has actually had", () => {
  const key = "agent:main:web:1d8d5bfd-de0e-4877-82cb-6bc2a77c6957";
  const episode = (n) => ({ name: `6bc2a77c6957-${n}` });

  const healthy = inspectEpisodeNumbering(key, [episode(3), episode(1), episode(2)]);
  assert.deepEqual(healthy, { seen: 3, highest: 3, duplicates: [], gaps: [] });

  // Three engines that each flushed the same restored buffer.
  const duplicated = inspectEpisodeNumbering(key, [episode(9), episode(10), episode(10), episode(10)]);
  assert.deepEqual(duplicated.duplicates, [10]);

  // A batch that never reached the backend.
  const lost = inspectEpisodeNumbering(key, [episode(1), episode(2), episode(5)]);
  assert.deepEqual(lost.gaps, [3, 4]);

  // Episodes of other sagas and standalone notes must not be counted here.
  const foreign = inspectEpisodeNumbering(key, [episode(1), { name: "deadbeefcafe-1" }, { name: "правило" }]);
  assert.equal(foreign.seen, 1);
});

test("status describes the shape of memory, not only its health", async (t) => {
  const hour = 3_600_000;
  const now = Date.now();
  installFetch(t, {
    get_queue_status: () => ({ group_id: "main", blocked: false, attempts: 0, pending: 0 }),
    get_saga: () => ({ error: "No saga named 'x' found in group 'main'" }),
    get_episodes: () => ({
      episodes: [
        { name: "aaa-2", content: "x".repeat(9000), created_at: new Date(now).toISOString(), source_description: "OpenClaw conversation batch" },
        { name: "aaa-1", content: "x".repeat(5000), created_at: new Date(now - 2 * hour).toISOString(), source_description: "OpenClaw conversation batch" },
        { name: "bbb-1", content: "x".repeat(1000), created_at: new Date(now - 3 * hour).toISOString(), source_description: "OpenClaw conversation batch" },
        { name: "правило", content: "note", created_at: new Date(now - hour).toISOString(), source_description: "OpenClaw agent note" },
      ],
    }),
  });
  const { tools } = makeRuntime();

  const result = await call(tools, "graphiti_status", {}, { agentId: "main", sessionKey: "agent:main:telegram:1" });
  const text = result.content[0].text;

  assert.equal(result.details.dialogs, 2, "two dialogs, counted by episode name prefix");
  assert.equal(result.details.notes, 1, "an explicit note is not a dialog batch");
  assert.equal(result.details.medianBatchChars, 5000);
  assert.equal(result.details.spanHours, 3);
  assert.match(text, /3 committed batch\(es\) from 2 dialog\(s\), plus 1 explicit note/);
  assert.match(text, /Typical committed batch is 5000 characters/);
});

test("status refuses to call a duplicated dialog healthy", async (t) => {
  installFetch(t, {
    get_queue_status: () => ({ group_id: "main", blocked: false, attempts: 0, pending: 0 }),
    get_saga: () => ({
      message: "retrieved", uuid: "s", name: "agent:main:telegram:1", group_id: "main",
      summary: "", first_episode_uuid: "a", last_episode_uuid: "b", episode_count: 4,
    }),
    get_episodes: () => ({
      episodes: [{ name: "1-3" }, { name: "1-2" }, { name: "1-2" }, { name: "1-1" }],
    }),
  });
  const { tools } = makeRuntime();

  const result = await call(tools, "graphiti_status", {},
    { agentId: "main", sessionKey: "agent:main:telegram:1" });

  // A finding is not a failed call: ok reports that the tool ran, healthy
  // reports what it found. Conflating them rendered every defect as an error.
  assert.equal(result.details.ok, true);
  assert.equal(result.details.healthy, false);
  assert.deepEqual(result.details.problems, ["duplicate_batches"]);
  assert.match(result.content[0].text, /batch number\(s\) 2 appear more than once/);
});

test("an episode name splits into its dialog and batch number", () => {
  assert.deepEqual(splitEpisodeName("8248439450-12"), { prefix: "8248439450", number: 12 });
  // Dialog keys contain dashes themselves, so only the final group is the number.
  assert.deepEqual(splitEpisodeName("agent:main:telegram-7-3"), { prefix: "agent:main:telegram-7", number: 3 });
  assert.equal(splitEpisodeName("note-abc12345"), undefined);
  assert.equal(splitEpisodeName("8248439450-0"), undefined);
});

test("a stored episode renders as dialogue under the participants' real names", () => {
  const rendered = renderEpisode({
    name: "8248439450-12",
    content: JSON.stringify({
      participants: { user: "Вит", assistant: "Краб" },
      messages: [
        { role: "user", text: "у нас была собака?" },
        { role: "assistant", text: "Бася, английский бульдог." },
      ],
    }),
  });

  assert.match(rendered, /\[8248439450-12\]/);
  assert.match(rendered, /Вит: у нас была собака\?/);
  assert.match(rendered, /Краб: Бася, английский бульдог\./);
});

test("an episode that is not the expected JSON is shown as it stands", () => {
  const rendered = renderEpisode({ name: "legacy-1", content: "plain text episode" });
  assert.equal(rendered, "[legacy-1]\nplain text episode");
});

test("context resolves a query through a fact to the conversation around it", async (t) => {
  const calls = installFetch(t, {
    search_memory_facts: () => ({
      facts: [{ fact: "Вит завёл бульдога Басю", episodes: ["episode-12"] }],
    }),
    get_episodes_by_ref: (args) => {
      const body = (name, line) => ({
        uuid: `u-${name}`,
        name,
        content: JSON.stringify({
          participants: { user: "Вит", assistant: "Краб" },
          messages: [{ role: "user", text: line }],
        }),
      });
      if (args.uuids.includes("episode-12")) return { episodes: [body("8248439450-12", "про собаку")] };
      return {
        episodes: [body("8248439450-11", "раньше"), body("8248439450-13", "позже")],
      };
    },
  });
  const { tools } = makeRuntime();

  const result = await call(tools, "graphiti_context", { query: "собака Бася" }, { agentId: "main", sessionKey: "agent:main:telegram:1" });
  const text = result.content[0].text;

  // Every lookup stays inside the calling agent's own graph.
  for (const params of calls) {
    if (params.name === "get_episodes_by_ref") assert.equal(params.arguments.group_id, "main");
  }
  assert.equal(result.details.episode, "8248439450-12");
  // Batches arrive in conversational order, not in the order they were fetched.
  assert.ok(text.indexOf("раньше") < text.indexOf("про собаку"));
  assert.ok(text.indexOf("про собаку") < text.indexOf("позже"));
  // The reply tells the model how to widen the window without guessing.
  assert.match(text, /episode="8248439450-12"/);
});

test("context centred on a named episode never searches for facts", async (t) => {
  const calls = installFetch(t, {
    get_episodes_by_ref: () => ({
      episodes: [{ uuid: "u", name: "8248439450-4", content: JSON.stringify({
        participants: { user: "Вит", assistant: "Краб" },
        messages: [{ role: "assistant", text: "вот этот кусок" }],
      }) }],
    }),
  });
  const { tools } = makeRuntime();

  const result = await call(tools, "graphiti_context", { episode: "8248439450-4" }, { agentId: "main", sessionKey: "agent:main:telegram:1" });

  assert.ok(!calls.some((params) => params.name === "search_memory_facts"));
  assert.match(result.content[0].text, /вот этот кусок/);
});

test("context says so plainly when memory holds nothing to expand", async (t) => {
  installFetch(t, { search_memory_facts: () => ({ facts: [] }) });
  const { tools } = makeRuntime();

  const result = await call(tools, "graphiti_context", { query: "чего там нет" }, { agentId: "main", sessionKey: "agent:main:telegram:1" });

  assert.equal(result.details.results, 0);
  assert.match(result.content[0].text, /OpenViking/);
});

test("context refuses a call with neither a query nor an episode", async (t) => {
  installFetch(t);
  const { tools } = makeRuntime();

  const result = await call(tools, "graphiti_context", {}, { agentId: "main", sessionKey: "agent:main:telegram:1" });

  assert.equal(result.details.reason, "no_anchor");
});

test("status reports graph shape and names the integrity problems it finds", async (t) => {
  installFetch(t, {
    get_queue_status: () => ({ group_id: "main", blocked: false, attempts: 0, pending: 0 }),
    get_episodes: () => ({ episodes: [] }),
    get_saga: () => ({ error: "No saga named 'agent:main:telegram:1' found in group 'main'" }),
    get_graph_stats: (args) => {
      assert.equal(args.group_id, "main");
      return {
        group_id: "main",
        size: { entities: 100, episodes: 13, sagas: 2, facts: 228, mentions: 90 },
        top_entities: [{ name: "Вит", degree: 57 }, { name: "Бася", degree: 4 }],
        oldest_episode: { name: "a", created_at: "2026-08-16" },
        newest_episode: { name: "b", created_at: "2026-08-17" },
        integrity: {
          duplicate_episode_names: [{ name: "8248439450-7", copies: 2 }],
          episodes_without_saga: 3,
          episodes_without_entities: 1,
          sagas_with_broken_chain: [{ saga: "telegram-1", heads: 2 }],
          facts_without_provenance: 5,
          isolated_entities: 2,
        },
        query_errors: [],
      };
    },
  });
  const { tools } = makeRuntime();

  const result = await call(tools, "graphiti_status", {}, { agentId: "main", sessionKey: "agent:main:telegram:1" });
  const text = result.content[0].text;

  assert.equal(result.details.ok, true);
  assert.equal(result.details.healthy, false);
  assert.deepEqual(result.details.problems, ["graph_integrity"]);
  assert.match(text, /100 entities, 228 facts/);
  assert.match(text, /Most connected: Вит \(57\), Бася \(4\)/);
  assert.match(text, /8248439450-7 exists 2 times/);
  assert.match(text, /telegram-1 has 2 chain starts/);
  assert.match(text, /3 episode\(s\) belong to no dialog/);
  assert.match(text, /5 fact\(s\) name no source episode/);
  assert.match(text, /Extraction yield: 1 episode\(s\) produced no entities/);
});

test("status states plainly when every integrity check passes", async (t) => {
  installFetch(t, {
    get_queue_status: () => ({ group_id: "main", blocked: false, attempts: 0, pending: 0 }),
    get_episodes: () => ({ episodes: [] }),
    get_saga: () => ({ error: "No saga named 'agent:main:telegram:1' found in group 'main'" }),
    get_graph_stats: () => ({
      size: { entities: 5, episodes: 2, sagas: 1, facts: 6, mentions: 4 },
      top_entities: [],
      integrity: {
        duplicate_episode_names: [],
        episodes_without_saga: 0,
        episodes_without_entities: 0,
        sagas_with_broken_chain: [],
        facts_without_provenance: 0,
        isolated_entities: 0,
      },
      query_errors: [],
    }),
  });
  const { tools } = makeRuntime();

  const result = await call(tools, "graphiti_status", {}, { agentId: "main", sessionKey: "agent:main:telegram:1" });

  assert.match(result.content[0].text, /Integrity checks passed/);
  assert.equal(result.details.ok, true);
  assert.equal(result.details.healthy, true);
});

test("a graph report that could not be read costs one line, not the whole status", async (t) => {
  installFetch(t, {
    get_queue_status: () => ({ group_id: "main", blocked: false, attempts: 0, pending: 2 }),
    get_episodes: () => ({ episodes: [] }),
    get_saga: () => ({ error: "No saga named 'agent:main:telegram:1' found in group 'main'" }),
    get_graph_stats: () => ({ error: "graph unavailable" }),
  });
  const { tools } = makeRuntime();

  const result = await call(tools, "graphiti_status", {}, { agentId: "main", sessionKey: "agent:main:telegram:1" });
  const text = result.content[0].text;

  assert.match(text, /Could not read graph statistics: graph unavailable/);
  assert.match(text, /Memory backend is healthy/);
  assert.match(text, /Settings: commit every/);
});

test("a standalone note is not reported as an episode detached from a dialog", async (t) => {
  const calls = installFetch(t, {
    get_queue_status: () => ({ group_id: "main", blocked: false, attempts: 0, pending: 0 }),
    get_episodes: () => ({ episodes: [] }),
    get_saga: () => ({ error: "No saga named 'agent:main:telegram:1' found in group 'main'" }),
    get_graph_stats: () => ({
      size: { entities: 1, episodes: 1, sagas: 0, facts: 0, mentions: 0 },
      top_entities: [],
      integrity: {
        duplicate_episode_names: [], episodes_without_saga: 0, episodes_without_entities: 0,
        sagas_with_broken_chain: [], facts_without_provenance: 0, isolated_entities: 0,
      },
      query_errors: [],
    }),
  });
  const { tools } = makeRuntime();

  await call(tools, "graphiti_status", {}, { agentId: "main", sessionKey: "agent:main:telegram:1" });

  // Older graphs still hold saga-less notes, so the server is
  // told which episodes are standalone by design rather than damaged.
  const stats = calls.find((params) => params.name === "get_graph_stats");
  assert.equal(stats.arguments.standalone_source_description, "OpenClaw agent note");
});

test("a dialog with nothing committed is not accused of losing a batch", () => {
  const empty = inspectEpisodeNumbering("agent:main:telegram:1", []);
  assert.deepEqual(empty, { seen: 0, highest: 0, duplicates: [], gaps: [] });

  // Nor when the window holds only other dialogs' episodes.
  const others = inspectEpisodeNumbering("agent:main:telegram:1", [{ name: "9999-1" }]);
  assert.deepEqual(others.gaps, []);
});
