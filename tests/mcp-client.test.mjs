import test from "node:test";
import assert from "node:assert/strict";
import { GraphitiMcpClient } from "../dist/mcp-client.js";

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
  assert.ok(call);
  assert.equal(call.payload.params.name, "search_memory_facts");
  assert.equal(call.payload.params.arguments.group_ids, "main");
  assert.equal(call.payload.params.arguments.max_facts, 6);
  assert.equal(call.headers.get("Mcp-Session-Id"), "session-one");
});

test("add_memory sends source json, saga and reference_time", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
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
    if (payload.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (payload.method === "tools/call") {
      calls.push(payload.params.arguments);
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          structuredContent: { message: "queued" },
          content: [],
          isError: false,
        },
      });
    }
    throw new Error("unexpected MCP request");
  };

  const client = new GraphitiMcpClient("http://127.0.0.1:8000/mcp/", 1000);
  await client.addMemory({
    name: "test",
    jsonBody: '{"participants":{"user":"Вит","assistant":"Краб"}}',
    groupId: "main",
    saga: "session-1",
    referenceTime: "2026-08-14T00:00:00.000Z",
  });

  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.equal(args.group_id, "main");
  assert.equal(args.source, "json");
  assert.equal(args.saga, "session-1");
  assert.equal(args.reference_time, "2026-08-14T00:00:00.000Z");
  assert.equal("uuid" in args, false);
  // кастомный промпт зашит в код и всегда передаётся
  assert.equal(typeof args.custom_extraction_instructions, "string");
  assert.match(args.custom_extraction_instructions, /messages.*ARRAY/);
});

test("raw logger receives full request and response bodies", async (t) => {
  const originalFetch = globalThis.fetch;
  const raws = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, init) => {
    if (JSON.parse(init.body).method === "initialize") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: JSON.parse(init.body).id,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} },
      });
    }
    if (JSON.parse(init.body).method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    return jsonResponse({
      jsonrpc: "2.0",
      id: JSON.parse(init.body).id,
      result: { structuredContent: { message: "queued" }, content: [], isError: false },
    });
  };

  const client = new GraphitiMcpClient("http://127.0.0.1:8000/mcp/", 1000, (kind, body) =>
    raws.push({ kind, body }),
  );
  await client.addMemory({
    name: "test",
    jsonBody: '{"participants":{"user":"Вит"}}',
    groupId: "main",
    saga: "s1",
    referenceTime: "2026-08-14T00:00:00.000Z",
  });

  assert.ok(raws.some((r) => r.kind === "request" && r.body.includes("add_memory")));
  assert.ok(raws.some((r) => r.kind === "request" && r.body.includes("episode_body")));
  assert.ok(raws.some((r) => r.kind === "response" && r.body.includes("queued")));
});
