import test from "node:test";
import assert from "node:assert/strict";
import { applyMessageRules, compileMessageRules } from "../dist/message-rules.js";
import { parseConfig } from "../dist/config.js";
import { buildRecallQuery } from "../dist/text.js";

const REPORT_RULE = {
  name: "tool-report",
  pattern: "⟦tool-report⟧",
  mode: "replace",
  replacement: "[a report]",
};

function rules(...list) {
  return compileMessageRules(parseConfig({ messageRules: list }).messageRules);
}

test("a message no rule matches comes back exactly as it was", () => {
  const outcome = applyMessageRules("нормальный разговор", rules(REPORT_RULE));
  assert.equal(outcome.kept, true);
  assert.equal(outcome.text, "нормальный разговор");
  assert.equal(outcome.rule, undefined);
});

test("replace keeps the turn and leaves nothing to extract from it", () => {
  const outcome = applyMessageRules("Вот отчёт:\n⟦tool-report⟧\nвсё в строю", rules(REPORT_RULE));
  assert.equal(outcome.kept, true);
  assert.equal(outcome.text, "[a report]");
  assert.equal(outcome.rule.name, "tool-report");
  // The original is carried so the log can say how much went.
  assert.ok(outcome.original.length > outcome.text.length);
});

test("ignore drops the message entirely", () => {
  const outcome = applyMessageRules("шум ⟦noise⟧ шум", rules({
    name: "noise", pattern: "⟦noise⟧", mode: "ignore",
  }));
  assert.equal(outcome.kept, false);
  assert.equal(outcome.rule.name, "noise");
});

test("the first matching rule decides, because a second would overwrite its work", () => {
  const outcome = applyMessageRules("⟦tool-report⟧", rules(
    REPORT_RULE,
    { name: "second", pattern: "⟦tool-report⟧", mode: "replace", replacement: "[wrong]" },
  ));
  assert.equal(outcome.text, "[a report]");
  assert.equal(outcome.rule.name, "tool-report");
});

test("a global regex answers the same way twice, having no memory between calls", () => {
  const compiled = compileMessageRules([
    { name: "g", pattern: "⟦x⟧", mode: "ignore", replacement: "", flags: "g" },
  ]);
  assert.equal(applyMessageRules("⟦x⟧", compiled).kept, false);
  assert.equal(applyMessageRules("⟦x⟧", compiled).kept, false);
});

test("no rules configured is the default, and it changes nothing", () => {
  assert.deepEqual(parseConfig({}).messageRules, []);
  const outcome = applyMessageRules("что угодно", []);
  assert.equal(outcome.kept, true);
  assert.equal(outcome.text, "что угодно");
});

test("a rule that would delete data is refused rather than quietly misread", () => {
  const bad = [
    [{ name: "x", pattern: "(", mode: "ignore" }, /not a valid regular expression/],
    [{ name: "", pattern: "x", mode: "ignore" }, /name must be a non-empty string/],
    [{ name: "x", pattern: "y", mode: "burn" }, /mode must be/],
    [{ name: "x", pattern: "y", mode: "replace" }, /replacement must not be empty/],
    [{ name: "x", pattern: "y", mode: "ignore", flags: "gx" }, /flags may only contain/],
    [{ name: "x", pattern: "y", mode: "ignore", patern: "typo" }, /unknown keys: patern/],
  ];
  for (const [rule, expected] of bad) {
    assert.throws(() => parseConfig({ messageRules: [rule] }), expected, JSON.stringify(rule));
  }
  assert.throws(
    () => parseConfig({ messageRules: [REPORT_RULE, { ...REPORT_RULE, pattern: "z" }] }),
    /two rules named/,
  );
});

test("a report among the recent turns does not become the search query", () => {
  const compiled = rules(REPORT_RULE);
  const history = [
    { role: "user", text: "что там по ключам?" },
    { role: "assistant", text: `⟦tool-report⟧ ${"таблица ".repeat(200)}` },
  ];
  const query = buildRecallQuery("а что вчера обсуждали?", history, {
    useHistory: true, historyMaxMessages: 4, historyMaxChars: 4096, maxChars: 8192,
    messageRules: compiled,
  });
  assert.ok(!query.includes("таблица"), "the table reached the query");
  assert.ok(query.includes("[a report]"), "the turn should still be visible as having happened");
  assert.ok(query.includes("что там по ключам"), "the real question was lost");
});

test("a prompt that is itself a report searches for nothing at all", () => {
  const query = buildRecallQuery("⟦tool-report⟧", [], {
    useHistory: true, historyMaxMessages: 4, historyMaxChars: 4096, maxChars: 8192,
    messageRules: rules({ name: "tool-report", pattern: "⟦tool-report⟧", mode: "ignore" }),
  });
  assert.equal(query, "");
});

test("without rules the recall query behaves exactly as before", () => {
  const history = [{ role: "user", text: "прошлый вопрос" }];
  const options = { useHistory: true, historyMaxMessages: 4, historyMaxChars: 4096, maxChars: 8192 };
  assert.equal(
    buildRecallQuery("новый вопрос", history, options),
    buildRecallQuery("новый вопрос", history, { ...options, messageRules: [] }),
  );
});
