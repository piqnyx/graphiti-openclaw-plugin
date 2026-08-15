import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, parseConfig } from "../dist/config.js";
import { requireAgentId } from "../dist/identity.js";
import {
  buildRecallBlock,
  extractConversationMessages,
  prepareRecallQuery,
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
