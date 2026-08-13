import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRecallBlock,
  extractCompletedTurn,
  prepareRecallQuery,
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

test("completed turn sanitizes injected wrappers from both user and assistant", () => {
  const turn = extractCompletedTurn([
    {
      role: "user",
      content: "user fact <openviking-context>hidden block</openviking-context>",
    },
    {
      role: "assistant",
      content: "assistant reply <graphiti-context>hidden block</graphiti-context>",
    },
  ]);
  assert.deepEqual(turn, { user: "user fact", assistant: "assistant reply" });
});

test("recall query bound applies after context sanitization", () => {
  const query = prepareRecallQuery(
    "<openviking-context>very long injected text</openviking-context>abcdefghijk",
    5,
  );
  assert.equal(query, "abcde");
});

test("recall XML never exceeds the configured character budget", () => {
  const maxChars = 180;
  const block = buildRecallBlock(
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
