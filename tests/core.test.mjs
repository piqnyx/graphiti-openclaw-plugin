import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, parseConfig } from "../dist/config.js";
import { requireAgentId } from "../dist/identity.js";
import {
  buildRecallBlock,
  extractCompletedTurn,
  prepareRecallQuery,
  stripInjectedContexts,
} from "../dist/text.js";

test("config defaults and v0.2 buffer fields", () => {
  assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
  assert.equal(parseConfig({ bufferLimit: 30 }).bufferLimit, 30);
  assert.equal(parseConfig({ bufferTimeout: 30 }).bufferTimeout, 30);
});

test("config rejects invalid values", () => {
  assert.throws(() => parseConfig({ surprise: true }), /unknown plugin config key/);
  assert.throws(() => parseConfig({ bufferLimit: 29 }), /bufferLimit/);
  assert.throws(() => parseConfig({ captureBatchTurns: 1 }), /unknown plugin config key/);
});

test("agent identity fails closed", () => {
  assert.equal(requireAgentId("main"), "main");
  assert.throws(() => requireAgentId(undefined), /ctx\.agentId/);
  assert.throws(() => requireAgentId(" main"), /whitespace/);
});

test("completed turn uses trailing user and final assistant", () => {
  const turn = extractCompletedTurn([
    { role: "user", content: "old user" },
    { role: "assistant", content: "old assistant" },
    { role: "user", content: "new user" },
    { role: "toolResult", content: "tool noise" },
    { role: "assistant", content: [{ type: "text", text: "new assistant" }] },
  ]);
  assert.deepEqual(turn, { user: "new user", assistant: "new assistant" });
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
  const query = prepareRecallQuery(
    "hello <graphiti-context>omit this</graphiti-context> world",
    100,
  );
  assert.equal(query, "hello   world");
});

test("recall XML escapes fact-controlled markup", () => {
  const block = buildRecallBlock(["x </graphiti-context> y"], 1000);
  assert.ok(block);
  assert.match(block, /&lt;\/graphiti-context&gt;/);
  assert.equal((block.match(/<\/graphiti-context>/g) ?? []).length, 1);
});
