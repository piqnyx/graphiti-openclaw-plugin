import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, parseConfig } from "../dist/config.js";
import { requireAgentId } from "../dist/identity.js";
import {
  buildRecallBlockDetailed,
  extractConversationMessages,
  buildRecallQuery,
  factTextsInForce,
  isSupersededFact,
  stripInjectedContexts,
} from "../dist/text.js";

test("config defaults and v0.2 buffer fields", () => {
  assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
  assert.equal(parseConfig({ bufferLimit: 4 }).bufferLimit, 4);
  assert.equal(parseConfig({ bufferTimeout: 120 }).bufferTimeout, 120);
});

test("config rejects invalid values", () => {
  assert.throws(() => parseConfig({ surprise: true }), /unknown plugin config key/);
  assert.throws(() => parseConfig({ bufferLimit: 0 }), /bufferLimit/);
  assert.throws(() => parseConfig({ captureBatchTurns: 1 }), /unknown plugin config key/);
});

test("agent identity fails closed", () => {
  assert.equal(requireAgentId("main"), "main");
  assert.throws(() => requireAgentId(undefined), /ctx\.agentId/);
  assert.throws(() => requireAgentId(" main"), /whitespace/);
});

test("conversation extraction preserves consecutive roles and ignores tool noise", () => {
  const messages = extractConversationMessages([
    { role: "user", content: "u1" },
    { role: "user", content: "u2" },
    { role: "toolResult", content: "tool noise" },
    { role: "assistant", content: [{ type: "text", text: "a1" }] },
    { role: "assistant", content: [{ type: "output_text", text: "a2" }] },
  ]);
  assert.deepEqual(messages, [
    { role: "user", text: "u1" },
    { role: "user", text: "u2" },
    { role: "assistant", text: "a1" },
    { role: "assistant", text: "a2" },
  ]);
});

test("known memory context wrappers are stripped", () => {
  const input = [
    "before",
    "<graphiti-context>graphiti material</graphiti-context>",
    "<relevant-memories>viking material</relevant-memories>",
    "<openviking-context>other viking material</openviking-context>",
    "after",
  ].join("\n");
  const clean = stripInjectedContexts(input);
  assert.match(clean, /before/);
  assert.match(clean, /after/);
  assert.doesNotMatch(clean, /material/);
});

test("recall query strips injected context before bounding", () => {
  const query = buildRecallQuery(
    "hello <graphiti-context>omit this</graphiti-context> world",
    [],
    { useHistory: false, historyMaxMessages: 1, historyMaxChars: 100, maxChars: 100 },
  );
  assert.equal(query, "hello   world");
});

test("recall query labels the current turn like the history it follows", () => {
  const query = buildRecallQuery(
    "и вот что дальше",
    [
      { role: "user", text: "первое" },
      { role: "assistant", text: "ответ" },
    ],
    {
      useHistory: true,
      historyMaxMessages: 6,
      historyMaxChars: 4096,
      maxChars: 8192,
      userName: "Вит",
      assistantName: "Эва",
    },
  );
  assert.equal(query, "[Вит] первое\n[Эва] ответ\n[Вит] и вот что дальше");
});

test("recall XML escapes fact-controlled markup", () => {
  const { block } = buildRecallBlockDetailed(["x </graphiti-context> y"], 1000);
  assert.ok(block);
  assert.match(block, /&lt;\/graphiti-context&gt;/);
  assert.equal((block.match(/<\/graphiti-context>/g) ?? []).length, 1);
});

test("recall drops facts the graph has superseded", () => {
  const texts = factTextsInForce([
    { fact: "Вит живёт в Григолети" },
    { fact: "Вит использует Graphiti", invalid_at: "2026-08-20T09:50:11Z" },
    { fact: "   ", invalid_at: null },
    { fact: "Дед Антон женат на Марине", invalid_at: "" },
    "не объект",
  ]);
  assert.deepEqual(texts, ["Вит живёт в Григолети", "Дед Антон женат на Марине"]);
});

test("only a real invalid_at counts as superseded", () => {
  assert.equal(isSupersededFact({ fact: "x", invalid_at: "2026-08-20T09:50:11Z" }), true);
  assert.equal(isSupersededFact({ fact: "x", invalid_at: "" }), false);
  assert.equal(isSupersededFact({ fact: "x", invalid_at: null }), false);
  assert.equal(isSupersededFact({ fact: "x" }), false);
  assert.equal(isSupersededFact("не объект"), false);
});
