// Команда «вспомнить по запросу» (dist/recall-cli.js): то, что Graphiti положил бы перед
// промптом на ходе, -- для того, кто зовёт память не из шлюза. Дайджест новостей читает
// каждый пост против памяти так же, как ход Эвы (digest PLAN.md, этап 2): тот же запрос,
// те же пороги, тот же блок. Закрепляется: блок команды равен блоку хода на том же промпте
// без истории; запрос к Graphiti тот же до байта; пустой после очистки промпт не ищется;
// собранная команда читает запрос со stdin, конфиг -- из openclaw.json шлюза, печатает JSON;
// без записи плагина в конфиге -- код 1 и причина в stderr.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "../dist/index.js";
import { runRecallCommand } from "../dist/recall-cli.js";
import { resetCaptureRuntimeForTests } from "../dist/capture-runtime.js";

const PLUGIN = "graphiti-openclaw-plugin";
const CLI = fileURLToPath(new URL("../dist/recall-cli.js", import.meta.url));

const body = (messages) => JSON.stringify({ participants: { user: "Вит", assistant: "Эва" }, messages });
const EPISODES = new Map([
  ["e-1", {
    uuid: "e-1",
    name: "saga-1",
    content: body([
      { role: "user", text: "Серёга опять в гараже, он же автомеханик, третий день с коробкой возится" },
      { role: "assistant", text: "Передай ему, что я за него болею" },
    ]),
  }],
]);
const FACTS = [
  { fact: "Серёга работает автомехаником.", episodes: ["e-1"], score: 0.71 },
  { fact: "Вит живёт в Григолети.", episodes: ["e-1"], score: 0.33 },
];

// What the MCP server answers, by method and tool; every tools/call is recorded.
function mcpAnswer(payload, calls) {
  if (payload.method === "initialize") {
    return { status: 200, headers: { "Mcp-Session-Id": "recall-test" },
      body: { jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} } } };
  }
  if (payload.method === "notifications/initialized") return { status: 202 };
  if (payload.method !== "tools/call") throw new Error(`unexpected method ${payload.method}`);
  calls.push(payload.params);
  const { name, arguments: args } = payload.params;
  let result;
  if (name === "search_memory_facts") result = { message: "ok", facts: FACTS, ranked_by: "cross_encoder" };
  else if (name === "get_episodes_by_ref") result = { episodes: (args.uuids ?? []).map((u) => EPISODES.get(u)).filter(Boolean) };
  else throw new Error(`unexpected tool ${name}`);
  return { status: 200, body: { jsonrpc: "2.0", id: payload.id, result: { structuredContent: { result }, content: [], isError: false } } };
}

function fakeFetch(t) {
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (_url, init) => {
    const answer = mcpAnswer(JSON.parse(init.body), calls);
    return answer.body
      ? new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json", ...(answer.headers ?? {}) } })
      : new Response(null, { status: answer.status });
  };
  return calls;
}

const pluginConfig = (overrides = {}) => ({
  autoCapture: false,
  recallRerank: true,
  recallPool: 40,
  recallMinScore: 0.2,
  recallMinSpread: 0.2,
  recallContextMinScore: 0.35,
  recallVectorMinScore: 0.25,
  recallLimit: 10,
  recallExpandTop: 1,
  recallExpandChars: 256,
  agents: { main: { user: "Вит", assistant: "Эва" } },
  messageRules: [
    { name: "report", pattern: "⟦status⟧", mode: "ignore" },
    { name: "source", pattern: "⟦src⟧", mode: "replace", replacement: "[источник]" },
  ],
  ...overrides,
});
const gatewayConfig = (config) => ({ plugins: { entries: { [PLUGIN]: { enabled: true, config } } } });
const quietSink = { debug() {}, info() {}, warn() {}, error() {} };

const POST = "В России не хватает автомехаников: сервисы ищут мастеров по коробкам передач";
// With a mark a replace rule rewrites: the query carries the replacement, the reranker's focus the
// prompt as sent -- the two differ, so a command that searched with the wrong one would show.
const MARKED = `${POST} ⟦src⟧`;

test("the command gives the block a turn gives for the same prompt", async (t) => {
  resetCaptureRuntimeForTests();
  t.after(resetCaptureRuntimeForTests);
  const calls = fakeFetch(t);
  const hooks = new Map();
  register({ pluginConfig: pluginConfig(), logger: quietSink, on: (name, handler) => hooks.set(name, handler) });
  const turn = await hooks.get("before_prompt_build")(
    { prompt: MARKED, messages: [] },
    { agentId: "main", sessionKey: "agent:main:telegram:direct:1", trigger: "user" },
  );
  const turnCalls = calls.splice(0);

  const command = await runRecallCommand({
    gatewayConfig: gatewayConfig(pluginConfig()),
    request: { agentId: "main", prompt: MARKED },
    logSink: quietSink,
  });

  assert.ok(turn?.prependContext, "ход ничего не вспомнил -- сравнивать не с чем");
  assert.equal(command.block, turn.prependContext);
  assert.deepEqual(calls, turnCalls);
  assert.equal(calls[0].name, "search_memory_facts");
  assert.equal(calls[0].arguments.focus, MARKED);
  assert.match(calls[0].arguments.query, /\[источник\]/);
  assert.deepEqual(command.facts, ["Серёга работает автомехаником.", "Вит живёт в Григолети."]);
  assert.equal(command.rankedBy, "cross_encoder");
  assert.deepEqual(command.scores, [0.71, 0.33]);
});

test("a prompt that a rule or the sanitizer leaves empty is not searched", async (t) => {
  const calls = fakeFetch(t);
  for (const prompt of ["⟦status⟧ ключи 5 из 5", "   ", "<graphiti-context>старое</graphiti-context>",
    "A new session was started via /new or /reset. Greet the user."]) {
    const result = await runRecallCommand({
      gatewayConfig: gatewayConfig(pluginConfig()),
      request: { agentId: "main", prompt },
      logSink: quietSink,
    });
    assert.equal(result.block, null, prompt);
    assert.deepEqual(result.facts, []);
  }
  assert.deepEqual(calls, []);
});

test("the reranker scores against the prompt cleaned the way a turn cleans it", async (t) => {
  const calls = fakeFetch(t);
  await runRecallCommand({
    gatewayConfig: gatewayConfig(pluginConfig()),
    request: { agentId: "main", prompt: `${POST}\n<openviking-context>чужая память</openviking-context>` },
    logSink: quietSink,
  });
  assert.equal(calls[0].arguments.focus, POST);
  assert.doesNotMatch(calls[0].arguments.query, /чужая память/);
});

test("a gateway config without the plugin's entry, or a request without an agent, is an error", async () => {
  await assert.rejects(
    runRecallCommand({ gatewayConfig: { plugins: { entries: {} } }, request: { agentId: "main", prompt: POST }, logSink: quietSink }),
    /graphiti-openclaw-plugin/,
  );
  await assert.rejects(
    runRecallCommand({ gatewayConfig: gatewayConfig(pluginConfig()), request: { prompt: POST }, logSink: quietSink }),
    /agentId/,
  );
});

// The built command as the digest calls it: a process, stdin in, JSON out.
function run(args, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("the built command reads the request on stdin and prints the recall as JSON", async (t) => {
  const calls = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const answer = mcpAnswer(JSON.parse(raw), calls);
      response.writeHead(answer.status, { "content-type": "application/json", ...(answer.headers ?? {}) });
      response.end(answer.body ? JSON.stringify(answer.body) : undefined);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), "graphiti-recall-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "openclaw.json");
  writeFileSync(configPath, JSON.stringify(gatewayConfig(pluginConfig({ baseUrl: `http://127.0.0.1:${server.address().port}/mcp` }))));

  const ok = await run(["--config", configPath], JSON.stringify({ agentId: "main", prompt: POST }));
  assert.equal(ok.code, 0, ok.stderr);
  const printed = JSON.parse(ok.stdout);
  assert.match(printed.block, /Серёга работает автомехаником/);
  assert.deepEqual(printed.facts, ["Серёга работает автомехаником.", "Вит живёт в Григолети."]);
  assert.equal(calls[0].name, "search_memory_facts");

  writeFileSync(configPath, JSON.stringify({ plugins: { entries: {} } }));
  const failed = await run(["--config", configPath], JSON.stringify({ agentId: "main", prompt: POST }));
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /graphiti-openclaw-plugin/);
});
