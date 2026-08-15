import test from "node:test";
import assert from "node:assert/strict";
import { GraphitiMcpClient, OPENCLAW_SOURCE_DESCRIPTION } from "../dist/mcp-client.js";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

test("MCP client initializes once and scopes fact search to group_id", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    requests.push({ payload, headers: new Headers(init.headers) });

    if (payload.method === "initialize") {
      return jsonResponse(
        {
          jsonrpc: "2.0",
          id: payload.id,
          result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} },
        },
        { headers: { "Mcp-Session-Id": "session-one" } },
      );
    }
    if (payload.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (payload.method === "tools/call") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          structuredContent: {
            message: "Facts retrieved successfully",
            facts: [{ fact: "Viktor likes tea", group_id: "main" }],
          },
          content: [],
          isError: false,
        },
      });
    }
    throw new Error(`unexpected method ${payload.method}`);
  };

  const client = new GraphitiMcpClient("http://127.0.0.1:8000/mcp/", 1000);
  const facts = await client.searchFacts("tea", "main", 6);
  assert.equal(facts.length, 1);

  const call = requests.find((request) => request.payload.method === "tools/call");
  assert.equal(call.payload.params.name, "search_memory_facts");
  assert.equal(call.payload.params.arguments.group_ids, "main");
  assert.equal(call.payload.params.arguments.max_facts, 6);
  assert.equal(call.headers.get("Mcp-Session-Id"), "session-one");
});

test("first add_memory sends reserved UUID, empty previous context and no saga predecessor", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const reservedUuid = "11111111-1111-4111-8111-111111111111";
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    if (payload.method === "initialize") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} },
      });
    }
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
    calls.push(payload.params.arguments);
    return jsonResponse({
      jsonrpc: "2.0",
      id: payload.id,
      result: {
        structuredContent: { result: { message: "queued", uuid: reservedUuid } },
        content: [],
        isError: false,
      },
    });
  };

  const client = new GraphitiMcpClient("http://127.0.0.1:8000/mcp/", 1000);
  const result = await client.addMemory({
    uuid: reservedUuid,
    name: "6bc2a77c6957-1",
    jsonBody: '{"participants":{"user":"Вит","assistant":"Краб"},"messages":[]}',
    groupId: "main",
    saga: "session-1",
    referenceTime: "2026-08-14T00:00:00.000Z",
    previousEpisodeUuids: [],
  });

  assert.equal(result.uuid, reservedUuid, "nested FastMCP structuredContent.result is unwrapped");
  const args = calls[0];
  assert.equal(args.uuid, reservedUuid);
  assert.equal(args.group_id, "main");
  assert.equal(args.source, "json");
  assert.equal(args.source_description, OPENCLAW_SOURCE_DESCRIPTION);
  assert.equal(args.saga, "session-1");
  assert.equal(args.reference_time, "2026-08-14T00:00:00.000Z");
  assert.deepEqual(args.previous_episode_uuids, []);
  assert.equal("saga_previous_episode_uuid" in args, false);
  assert.equal(typeof args.custom_extraction_instructions, "string");
  assert.match(args.custom_extraction_instructions, /messages.*ARRAY/);
});

test("later add_memory sends caller UUID plus exactly one semantic and saga predecessor", async (t) => {
  const originalFetch = globalThis.fetch;
  let args;
  const reservedUuid = "22222222-2222-4222-8222-222222222222";
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    if (payload.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18" } });
    }
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
    args = payload.params.arguments;
    return jsonResponse({
      jsonrpc: "2.0",
      id: payload.id,
      result: { structuredContent: { result: { message: "queued", uuid: reservedUuid } }, content: [], isError: false },
    });
  };

  const client = new GraphitiMcpClient("http://127.0.0.1:8000/mcp/", 1000);
  const result = await client.addMemory({
    uuid: reservedUuid,
    name: "session-2",
    jsonBody: "{}",
    groupId: "main",
    saga: "session",
    referenceTime: "2026-08-14T00:01:00.000Z",
    previousEpisodeUuids: ["uuid-1"],
    sagaPreviousEpisodeUuid: "uuid-1",
  });

  assert.equal(result.uuid, reservedUuid);
  assert.equal(args.uuid, reservedUuid);
  assert.deepEqual(args.previous_episode_uuids, ["uuid-1"]);
  assert.equal(args.saga_previous_episode_uuid, "uuid-1");
});

test("getSaga maps persisted recovery state and scopes lookup to the agent group", async (t) => {
  const originalFetch = globalThis.fetch;
  let args;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    if (payload.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18" } });
    }
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
    args = payload.params;
    return jsonResponse({
      jsonrpc: "2.0",
      id: payload.id,
      result: {
        structuredContent: {
          result: {
            message: "retrieved",
            uuid: "saga-uuid",
            name: "session-1",
            group_id: "main",
            created_at: "2026-08-15T00:00:00+00:00",
            summary: "",
            first_episode_uuid: "ep-1",
            last_episode_uuid: "ep-6",
            episode_count: 6,
          },
        },
        content: [],
        isError: false,
      },
    });
  };

  const client = new GraphitiMcpClient("http://127.0.0.1:8000/mcp/", 1000);
  const saga = await client.getSaga("session-1", "main");

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
  });
});

test("getSaga returns undefined for a missing saga", async (t) => {
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
    return jsonResponse({
      jsonrpc: "2.0",
      id: payload.id,
      result: {
        structuredContent: { result: { error: "No saga named 'missing' found in group 'main'" } },
        content: [],
        isError: false,
      },
    });
  };

  const client = new GraphitiMcpClient("http://127.0.0.1:8000/mcp/", 1000);
  assert.equal(await client.getSaga("missing", "main"), undefined);
});

test("raw logger receives full request and response bodies", async (t) => {
  const originalFetch = globalThis.fetch;
  const raws = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    if (payload.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18" } });
    }
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
    return jsonResponse({
      jsonrpc: "2.0",
      id: payload.id,
      result: { structuredContent: { result: { message: "queued", uuid: "33333333-3333-4333-8333-333333333333" } }, content: [], isError: false },
    });
  };

  const client = new GraphitiMcpClient("http://127.0.0.1:8000/mcp/", 1000, (kind, body) =>
    raws.push({ kind, body }),
  );
  await client.addMemory({
    uuid: "33333333-3333-4333-8333-333333333333",
    name: "test",
    jsonBody: "{}",
    groupId: "main",
    saga: "s1",
    referenceTime: "2026-08-14T00:00:00.000Z",
    previousEpisodeUuids: [],
  });

  assert.ok(raws.some((r) => r.kind === "request" && r.body.includes("add_memory")));
  assert.ok(raws.some((r) => r.kind === "request" && r.body.includes("previous_episode_uuids")));
  assert.ok(raws.some((r) => r.kind === "request" && r.body.includes("33333333-3333-4333-8333-333333333333")));
  assert.ok(raws.some((r) => r.kind === "response" && r.body.includes("uuid")));
});
