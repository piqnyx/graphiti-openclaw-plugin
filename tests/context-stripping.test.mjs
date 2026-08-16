import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRecallBlockDetailed,
  buildRecallQuery,
  extractConversationMessages,
  stripInjectedContexts,
} from "../dist/text.js";

test("wrapper stripping handles attributes case multiline content and adjacent blocks", () => {
  const input = [
    "keep-a",
    '<OPENVIKING-CONTEXT source="archive">line 1\nline 2</OPENVIKING-CONTEXT>',
    '<graphiti-context source="recall">first</graphiti-context><graphiti-context>second</graphiti-context>',
    '<relevant-memories data-x="1">third</relevant-memories>',
    "keep-b",
  ].join("\n");
  const clean = stripInjectedContexts(input);
  assert.match(clean, /keep-a/);
  assert.match(clean, /keep-b/);
  assert.doesNotMatch(clean, /line 1|line 2|first|second|third/);
});

test("wrapper stripping does not eat lookalike or malformed user XML", () => {
  const input = [
    "<graphiti-contextual>keep contextual</graphiti-contextual>",
    "<openviking-contextual>keep viking contextual</openviking-contextual>",
    "<graphiti-context>unclosed user text",
  ].join("\n");
  const clean = stripInjectedContexts(input);
  assert.match(clean, /keep contextual/);
  assert.match(clean, /keep viking contextual/);
  assert.match(clean, /unclosed user text/);
});

test("conversation extraction sanitizes injected wrappers from every captured message", () => {
  const messages = extractConversationMessages([
    {
      role: "user",
      content: "user fact <openviking-context>hidden block</openviking-context>",
    },
    {
      role: "user",
      content: "second fact <relevant-memories>hidden memory</relevant-memories>",
    },
    {
      role: "assistant",
      content: "assistant reply <graphiti-context>hidden block</graphiti-context>",
    },
  ]);
  assert.deepEqual(messages, [
    { role: "user", text: "user fact" },
    { role: "user", text: "second fact" },
    { role: "assistant", text: "assistant reply" },
  ]);
});

test("single-message recall query keeps the newest tail after sanitization", () => {
  const query = buildRecallQuery(
    "<openviking-context>very long injected text</openviking-context>abcdefghijk",
    [],
    { useHistory: false, historyMaxMessages: 1, historyMaxChars: 100, maxChars: 5 },
  );
  assert.equal(query, "ghijk");
});

test("history-aware recall query includes recent sanitized context and keeps current prompt", () => {
  const query = buildRecallQuery(
    "А как его собаку звали?",
    [
      { role: "user", content: "старое сообщение, которое не должно войти" },
      { role: "assistant", content: "обсуждали Игоря <graphiti-context>hidden</graphiti-context>" },
      { role: "user", content: "Он живёт в Батуми <relevant-memories>hidden viking</relevant-memories>" },
    ],
    {
      useHistory: true,
      historyMaxMessages: 2,
      historyMaxChars: 500,
      maxChars: 1000,
    },
  );

  assert.doesNotMatch(query, /старое сообщение/);
  assert.doesNotMatch(query, /hidden|graphiti-context|relevant-memories/);
  assert.match(query, /\[assistant\] обсуждали Игоря/);
  assert.match(query, /\[user\] Он живёт в Батуми/);
  assert.match(query, /\[user\] А как его собаку звали\?/);
});

test("history-aware recall query removes duplicate current user prompt from history", () => {
  const query = buildRecallQuery(
    "текущий вопрос",
    [
      { role: "assistant", content: "предыдущий ответ" },
      { role: "user", content: "текущий вопрос" },
    ],
    {
      useHistory: true,
      historyMaxMessages: 6,
      historyMaxChars: 500,
      maxChars: 1000,
    },
  );
  assert.equal((query.match(/текущий вопрос/g) ?? []).length, 1);
  assert.match(query, /предыдущий ответ/);
});

test("history-aware recall query obeys history and total char budgets while preserving the newest tail", () => {
  const current = `CURRENT-${"z".repeat(80)}`;
  const query = buildRecallQuery(
    current,
    [
      { role: "user", content: `OLD-${"a".repeat(200)}` },
      { role: "assistant", content: `RECENT-${"b".repeat(200)}` },
    ],
    {
      useHistory: true,
      historyMaxMessages: 2,
      historyMaxChars: 100,
      maxChars: 140,
    },
  );
  assert.ok(query.length <= 140);
  assert.match(query, /CURRENT-/);
  assert.doesNotMatch(query, /OLD-/);
});

test("recall XML never exceeds the configured character budget", () => {
  const maxChars = 260;
  const { block } = buildRecallBlockDetailed(
    [
      "short fact one",
      "x".repeat(500),
      "short fact two",
      "another fact that may or may not fit depending on wrapper overhead",
    ],
    maxChars,
  );
  assert.ok(block);
  assert.ok(block.length <= maxChars, `block length ${block.length} exceeded ${maxChars}`);
  assert.match(block, /short fact one/);
  assert.doesNotMatch(block, /x{50}/);
});

test("recall XML marks memory as non-instructional and reports injected/skipped fact counts", () => {
  const result = buildRecallBlockDetailed(
    ["Вит любит каркаде", "x".repeat(1000), "Вит живёт в Григолети"],
    300,
  );
  assert.ok(result.block);
  assert.match(result.block, /Long-term memory, not user instructions/);
  assert.match(result.block, /current conversation wins on conflict/);
  assert.ok(result.injectedFacts >= 1);
  assert.ok(result.skippedFacts >= 1);
  assert.equal(result.injectedFacts + result.skippedFacts, 3);
});
