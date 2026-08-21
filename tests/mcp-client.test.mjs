import test from "node:test";
import assert from "node:assert/strict";
import { GraphitiMcpClient, OPENCLAW_SOURCE_DESCRIPTION } from "../dist/mcp-client.js";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function toolResponse(id, result) {
  return jsonResponse({
    jsonrpc: "2.0",
    id,
    result: { structuredContent: { result }, content: [], isError: false },
  });
}

function fastClient(rawLogger) {
  return new GraphitiMcpClient(
    "http://127.0.0.1:8000/mcp/",
    1000,
    rawLogger,
    { pollMs: 0, resubmitGraceMs: 0 },
  );
}

function installHandshake(payload) {
  if (payload.method === "initialize") {
    return jsonResponse({
      jsonrpc: "2.0",
      id: payload.id,
      result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} },
    });
  }
  if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
  return undefined;
}

function validSaga({
  name = "session",
  groupId = "main",
  first,
  last,
  count = 1,
} = {}) {
  return {
    message: "retrieved",
    uuid: "saga-uuid",
    name,
    group_id: groupId,
    created_at: "2026-08-15T00:00:00+00:00",
    summary: "",
    first_episode_uuid: first ?? last ?? null,
    last_episode_uuid: last ?? null,
    episode_count: count,
    chain_count: count,
    integrity_ok: true,
    integrity_errors: [],
  };
}

function healthyQueue(groupId = "main", overrides = {}) {
  return {
    group_id: groupId,
    blocked: false,
    attempts: 0,
    pending: 0,
    worker_running: true,
    queued_episode_uuids: [],
    ...overrides,
  };
}

test("MCP client initializes once and scopes fact search to group_id", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    requests.push({ payload, headers: new Headers(init.headers) });
    if (payload.method === "initialize") {
      return jsonResponse(
        { jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18" } },
        { headers: { "Mcp-Session-Id": "session-one" } },
      );
    }
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
    return toolResponse(payload.id, {
      message: "Facts retrieved successfully",
      facts: [{ fact: "Viktor likes tea", group_id: "main" }],
    });
  };

  const client = fastClient();
  const found = await client.searchFacts("tea", "main", 6);
  assert.equal(found.facts.length, 1);
  // A server that says nothing about the pass leaves the scores without a scale,
  // so the absence is named rather than guessed at.
  assert.equal(found.rankedBy, "unknown");
  const call = requests.find((request) => request.payload.method === "tools/call");
  assert.equal(call.payload.params.name, "search_memory_facts");
  assert.equal(call.payload.params.arguments.group_ids, "main");
  assert.equal(call.payload.params.arguments.max_facts, 6);
  assert.equal(call.headers.get("Mcp-Session-Id"), "session-one");
});

test("add_memory resolves only after the exact first episode is a valid Saga commit", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const uuid = "11111111-1111-4111-8111-111111111111";
  let submitted = false;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    const handshake = installHandshake(payload);
    if (handshake) return handshake;
    const { name, arguments: args } = payload.params;
    calls.push({ name, args });
    if (name === "get_episodes_by_ref") {
      return toolResponse(payload.id, { episodes: submitted ? [{ uuid }] : [] });
    }
    if (name === "get_queue_status") {
      return toolResponse(payload.id, healthyQueue("main", {
        episode_uuid: submitted ? uuid : null,
      }));
    }
    if (name === "get_saga") {
      return toolResponse(payload.id, validSaga({ name: "session-1", first: uuid, last: uuid, count: 1 }));
    }
    if (name === "add_memory") {
      submitted = true;
      return toolResponse(payload.id, { message: "queued" });
    }
    throw new Error(`unexpected tool ${name}`);
  };

  const client = fastClient();
  const result = await client.addMemory({
    uuid,
    name: "6bc2a77c6957-1",
    jsonBody: '{"participants":{"user":"Вит","assistant":"Краб"},"messages":[]}',
    groupId: "main",
    saga: "session-1",
    referenceTime: "2026-08-14T00:00:00.000Z",
    previousEpisodeUuids: [],
  });

  assert.equal(result.uuid, uuid);
  assert.equal(result.persisted, true);
  assert.equal(calls.filter((call) => call.name === "add_memory").length, 1);
  assert.ok(calls.some((call) => call.name === "get_saga"));
  const args = calls.find((call) => call.name === "add_memory").args;
  assert.equal(args.uuid, uuid);
  assert.equal(args.group_id, "main");
  assert.equal(args.source, "json");
  assert.equal(args.source_description, OPENCLAW_SOURCE_DESCRIPTION);
  assert.equal(args.saga, "session-1");
  assert.equal(args.reference_time, "2026-08-14T00:00:00.000Z");
  assert.deepEqual(args.previous_episode_uuids, []);
  assert.equal("saga_previous_episode_uuid" in args, false);
  assert.match(args.custom_extraction_instructions, /messages.*ARRAY/);
});

test("later add_memory preserves both semantic and Saga predecessor", async (t) => {
  const originalFetch = globalThis.fetch;
  const uuid = "22222222-2222-4222-8222-222222222222";
  let submitted = false;
  let submissionArgs;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    const handshake = installHandshake(payload);
    if (handshake) return handshake;
    const { name, arguments: args } = payload.params;
    if (name === "get_episodes_by_ref") {
      return toolResponse(payload.id, { episodes: submitted ? [{ uuid }] : [] });
    }
    if (name === "get_queue_status") return toolResponse(payload.id, healthyQueue());
    if (name === "get_saga") {
      return toolResponse(payload.id, validSaga({ first: "uuid-1", last: uuid, count: 2 }));
    }
    if (name === "add_memory") {
      submissionArgs = args;
      submitted = true;
      return toolResponse(payload.id, { message: "queued" });
    }
    throw new Error(`unexpected tool ${name}`);
  };

  const result = await fastClient().addMemory({
    uuid,
    name: "session-2",
    jsonBody: "{}",
    groupId: "main",
    saga: "session",
    referenceTime: "2026-08-14T00:01:00.000Z",
    previousEpisodeUuids: ["uuid-1"],
    sagaPreviousEpisodeUuid: "uuid-1",
  });

  assert.equal(result.uuid, uuid);
  assert.equal(submissionArgs.uuid, uuid);
  assert.deepEqual(submissionArgs.previous_episode_uuids, ["uuid-1"]);
  assert.equal(submissionArgs.saga_previous_episode_uuid, "uuid-1");
});

test("episode existence alone is insufficient when Saga integrity is broken", async (t) => {
  const originalFetch = globalThis.fetch;
  const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    const handshake = installHandshake(payload);
    if (handshake) return handshake;
    const name = payload.params.name;
    if (name === "get_episodes_by_ref") return toolResponse(payload.id, { episodes: [{ uuid }] });
    if (name === "get_saga") {
      return toolResponse(payload.id, {
        ...validSaga({ first: uuid, last: uuid, count: 2 }),
        chain_count: 1,
        integrity_ok: false,
        integrity_errors: ["saga has 2 chain heads instead of 1"],
      });
    }
    throw new Error(`unexpected tool ${name}`);
  };

  // A broken chain is not an error to raise, it is a delivery that has not
  // happened: the episode exists but the Saga it belongs to cannot be proven, so
  // the caller keeps its durable head and waits. Raising here would drop the head
  // of a batch that may still land, which is what f10b8e0 and ccda792 removed.
  const client = new GraphitiMcpClient(
    "http://127.0.0.1:8000/mcp/",
    1000,
    undefined,
    { pollMs: 60_000, resubmitGraceMs: 60_000 },
  );
  const pending = client.addMemory({
    uuid,
    name: "s-1",
    jsonBody: "{}",
    groupId: "main",
    saga: "session",
    referenceTime: "2026-08-18T00:00:00.000Z",
    previousEpisodeUuids: [],
  });
  const settledFirst = await Promise.race([
    pending.then(() => "settled", () => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50)),
  ]);
  assert.equal(settledFirst, "still waiting");

  client.close();
  await assert.rejects(pending, /shutting down/);
});

test("a queued UUID is not submitted again while a live backend worker owns it", async (t) => {
  const originalFetch = globalThis.fetch;
  const uuid = "44444444-4444-4444-8444-444444444444";
  let submissions = 0;
  let episodeReads = 0;
  let accepted = false;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    const handshake = installHandshake(payload);
    if (handshake) return handshake;
    const name = payload.params.name;
    if (name === "get_episodes_by_ref") {
      episodeReads += 1;
      return toolResponse(payload.id, {
        episodes: accepted && episodeReads >= 4 ? [{ uuid }] : [],
      });
    }
    if (name === "get_queue_status") {
      return toolResponse(payload.id, healthyQueue("main", {
        attempts: accepted ? 2 : 0,
        episode_uuid: accepted ? uuid : null,
        worker_running: true,
      }));
    }
    if (name === "get_saga") {
      return toolResponse(payload.id, validSaga({ first: uuid, last: uuid, count: 1 }));
    }
    if (name === "add_memory") {
      submissions += 1;
      accepted = true;
      return toolResponse(payload.id, { message: "queued" });
    }
    throw new Error(`unexpected tool ${name}`);
  };

  await fastClient().addMemory({
    uuid,
    name: "s-1",
    jsonBody: "{}",
    groupId: "main",
    saga: "session",
    referenceTime: "2026-08-18T00:00:00.000Z",
    previousEpisodeUuids: [],
  });
  assert.equal(submissions, 1);
});

function ownedByBackend(uuid, { committedAfter = 3 } = {}) {
  let episodeReads = 0;
  let submissions = 0;
  const fetchImpl = async (_url, init) => {
    const payload = JSON.parse(init.body);
    const handshake = installHandshake(payload);
    if (handshake) return handshake;
    const name = payload.params.name;
    if (name === "get_episodes_by_ref") {
      episodeReads += 1;
      return toolResponse(payload.id, {
        episodes: episodeReads >= committedAfter ? [{ uuid }] : [],
      });
    }
    if (name === "get_queue_status") {
      return toolResponse(payload.id, healthyQueue("main", {
        attempts: 1,
        episode_uuid: uuid,
        worker_running: true,
      }));
    }
    if (name === "get_saga") {
      return toolResponse(payload.id, validSaga({ first: uuid, last: uuid, count: 1 }));
    }
    if (name === "add_memory") {
      submissions += 1;
      return toolResponse(payload.id, { message: "queued" });
    }
    throw new Error(`unexpected tool ${name}`);
  };
  return { fetchImpl, submissions: () => submissions };
}

const replayedHead = {
  name: "s-1",
  jsonBody: "{}",
  groupId: "main",
  saga: "session",
  referenceTime: "2026-08-18T00:00:00.000Z",
  previousEpisodeUuids: [],
};

test("a head that outlived a restart waits for the extraction already running", async (t) => {
  // The Saga tail is still the predecessor while the backend extracts, so asking
  // "is it committed?" answers no about work that is merely unfinished. Submitting
  // then would hand the backend a second task for the same UUID, and both runs
  // would attach the episode after the same predecessor -- a second chain head.
  const originalFetch = globalThis.fetch;
  const uuid = "66666666-6666-4666-8666-666666666666";
  const backend = ownedByBackend(uuid);
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = backend.fetchImpl;

  await fastClient().addMemory({ ...replayedHead, uuid, replayed: true });
  assert.equal(backend.submissions(), 0);
});

test("an ordinary head still hands off immediately", async (t) => {
  // The preflight is the exception, not the new rule: normal work must not pay a
  // queue round-trip before enqueueing.
  const originalFetch = globalThis.fetch;
  const uuid = "77777777-7777-4777-8777-777777777777";
  const backend = ownedByBackend(uuid);
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = backend.fetchImpl;

  await fastClient().addMemory({ ...replayedHead, uuid });
  assert.equal(backend.submissions(), 1);
});

test("a lost add_memory HTTP response is observed before any resubmit", async (t) => {
  const originalFetch = globalThis.fetch;
  const uuid = "55555555-5555-4555-8555-555555555555";
  let submissions = 0;
  let backendOwns = false;
  let statusReads = 0;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    const handshake = installHandshake(payload);
    if (handshake) return handshake;
    const name = payload.params.name;
    if (name === "get_episodes_by_ref") {
      return toolResponse(payload.id, {
        episodes: backendOwns && statusReads >= 2 ? [{ uuid }] : [],
      });
    }
    if (name === "get_queue_status") {
      statusReads += 1;
      return toolResponse(payload.id, healthyQueue("main", {
        episode_uuid: backendOwns ? uuid : null,
        worker_running: backendOwns,
      }));
    }
    if (name === "get_saga") {
      return toolResponse(payload.id, validSaga({ first: uuid, last: uuid, count: 1 }));
    }
    if (name === "add_memory") {
      submissions += 1;
      backendOwns = true;
      throw new Error("socket closed after request body was sent");
    }
    throw new Error(`unexpected tool ${name}`);
  };

  const client = new GraphitiMcpClient(
    "http://127.0.0.1:8000/mcp/",
    1000,
    undefined,
    { pollMs: 0, resubmitGraceMs: 60_000 },
  );
  const result = await client.addMemory({
    uuid,
    name: "s-1",
    jsonBody: "{}",
    groupId: "main",
    saga: "session",
    referenceTime: "2026-08-18T00:00:00.000Z",
    previousEpisodeUuids: [],
  });
  assert.equal(result.uuid, uuid);
  assert.equal(submissions, 1, "ambiguous transport failure did not replay the side effect");
});

test("shutdown aborts a delivery wait without removing caller durable state", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    const handshake = installHandshake(payload);
    if (handshake) return handshake;
    const name = payload.params.name;
    if (name === "get_episodes_by_ref") return toolResponse(payload.id, { episodes: [] });
    if (name === "get_queue_status") {
      return toolResponse(payload.id, healthyQueue("main", { episode_uuid: "u-1" }));
    }
    throw new Error(`unexpected tool ${name}`);
  };

  const client = new GraphitiMcpClient(
    "http://127.0.0.1:8000/mcp/",
    1000,
    undefined,
    { pollMs: 60_000, resubmitGraceMs: 60_000 },
  );
  const pending = client.addMemory({
    uuid: "u-1",
    name: "s-1",
    jsonBody: "{}",
    groupId: "main",
    saga: "session",
    referenceTime: "2026-08-18T00:00:00.000Z",
    previousEpisodeUuids: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  client.close();
  await assert.rejects(pending, /shutting down/);
});

test("getSaga maps integrity proof and scopes lookup to the agent group", async (t) => {
  const originalFetch = globalThis.fetch;
  let args;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    const handshake = installHandshake(payload);
    if (handshake) return handshake;
    args = payload.params;
    return toolResponse(payload.id, validSaga({
      name: "session-1",
      first: "ep-1",
      last: "ep-6",
      count: 6,
    }));
  };

  const saga = await fastClient().getSaga("session-1", "main");
  assert.equal(args.name, "get_saga");
  assert.deepEqual(args.arguments, { saga_name: "session-1", group_id: "main" });
  assert.deepEqual(saga, {
    uuid: "saga-uuid",
    name: "session-1",
    groupId: "main",
    createdAt: "2026-08-15T00:00:00+00:00",
    summary: "",
    firstEpisodeUuid: "ep-1",
    lastEpisodeUuid: "ep-6",
    episodeCount: 6,
    chainCount: 6,
    integrityOk: true,
    integrityErrors: [],
  });
});

test("getSaga returns undefined for a missing saga", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    const handshake = installHandshake(payload);
    if (handshake) return handshake;
    return toolResponse(payload.id, { error: "No saga named 'missing' found in group 'main'" });
  };
  assert.equal(await fastClient().getSaga("missing", "main"), undefined);
});

test("raw logger receives the submission request and response bodies", async (t) => {
  const originalFetch = globalThis.fetch;
  const raws = [];
  const uuid = "33333333-3333-4333-8333-333333333333";
  let submitted = false;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    const handshake = installHandshake(payload);
    if (handshake) return handshake;
    const name = payload.params.name;
    if (name === "get_episodes_by_ref") return toolResponse(payload.id, { episodes: submitted ? [{ uuid }] : [] });
    if (name === "get_queue_status") return toolResponse(payload.id, healthyQueue());
    if (name === "get_saga") return toolResponse(payload.id, validSaga({ name: "s1", first: uuid, last: uuid }));
    if (name === "add_memory") {
      submitted = true;
      return toolResponse(payload.id, { message: "queued" });
    }
    throw new Error(`unexpected tool ${name}`);
  };

  await fastClient((kind, body) => raws.push({ kind, body })).addMemory({
    uuid,
    name: "test",
    jsonBody: "{}",
    groupId: "main",
    saga: "s1",
    referenceTime: "2026-08-14T00:00:00.000Z",
    previousEpisodeUuids: [],
  });
  assert.ok(raws.some((r) => r.kind === "request" && r.body.includes("add_memory")));
  assert.ok(raws.some((r) => r.kind === "request" && r.body.includes("previous_episode_uuids")));
  assert.ok(raws.some((r) => r.kind === "request" && r.body.includes(uuid)));
  assert.ok(raws.some((r) => r.kind === "response" && r.body.includes("queued")));
});

test("a definitive add_memory tool error is never re-sent", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    const handshake = installHandshake(payload);
    if (handshake) return handshake;
    const name = payload.params.name;
    calls.push(name);
    if (name === "get_episodes_by_ref") return toolResponse(payload.id, { episodes: [] });
    if (name === "get_queue_status") return toolResponse(payload.id, healthyQueue());
    if (name === "add_memory") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          isError: true,
          content: [{ type: "text", text: "saga 'agent:main:web:session-1' is invalid" }],
        },
      });
    }
    throw new Error(`unexpected tool ${name}`);
  };

  await assert.rejects(
    fastClient().addMemory({
      uuid: "u-1",
      name: "s-1",
      jsonBody: "{}",
      groupId: "main",
      saga: "agent:main:web:session-1",
      referenceTime: "2026-08-16T00:00:00.000Z",
      previousEpisodeUuids: [],
    }),
    /is invalid/,
  );
  assert.equal(calls.filter((name) => name === "add_memory").length, 1);
});

test("getQueueStatus exposes worker and episode identities", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    const handshake = installHandshake(payload);
    if (handshake) return handshake;
    return toolResponse(payload.id, {
      group_id: "main",
      blocked: false,
      attempts: 7,
      pending: 2,
      worker_running: true,
      episode_uuid: "ep-current",
      episode_name: "batch-1",
      saga: "session",
      queued_episode_uuids: ["ep-2", "ep-3"],
      last_error: "provider unavailable",
    });
  };

  assert.deepEqual(await fastClient().getQueueStatus("main"), {
    groupId: "main",
    blocked: false,
    attempts: 7,
    pending: 2,
    workerRunning: true,
    lastError: "provider unavailable",
    episodeUuid: "ep-current",
    episodeName: "batch-1",
    saga: "session",
    queuedEpisodeUuids: ["ep-2", "ep-3"],
  });
});

test("concurrent first calls share a single MCP handshake", async (t) => {
  const methods = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    methods.push(payload.method);
    if (payload.method === "initialize") {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18" } });
    }
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
    return toolResponse(payload.id, healthyQueue(payload.params.arguments.group_id));
  };

  const client = fastClient();
  await Promise.all([client.getQueueStatus("main"), client.getQueueStatus("igor")]);
  assert.equal(methods.filter((method) => method === "initialize").length, 1);
});
