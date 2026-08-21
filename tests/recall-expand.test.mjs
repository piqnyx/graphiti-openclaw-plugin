import test from "node:test";
import assert from "node:assert/strict";
import { anchorCandidates, windowAround } from "../dist/recall-expand.js";
import { buildRecallBlockDetailed, factsInForce } from "../dist/text.js";

test("the anchor is the most specific proper noun the fact carries", () => {
  assert.deepEqual(
    anchorCandidates("Вит теперь живет в Кобулети у моря, переехав туда."),
    ["Кобулети", "Вит"],
  );
  assert.deepEqual(anchorCandidates("он переехал вчера"), []);
});

test("the window is cut around the anchor and says where it was cut", () => {
  const text = `${"а".repeat(400)} Кобулети ${"б".repeat(400)}`;
  const window = windowAround(text, ["Кобулети"], 20);
  assert.match(window, /Кобулети/);
  assert.ok(window.startsWith("…"), "начало обрезано, а многоточия нет");
  assert.ok(window.endsWith("…"), "конец обрезан, а многоточия нет");
  assert.ok(window.length < 120, `окно шире запрошенного: ${window.length}`);
});

test("a fact whose nouns are nowhere falls back to the end of the episode", () => {
  const text = `${"начало ".repeat(50)}последняя реплика`;
  const window = windowAround(text, ["Отсутствует"], 30);
  assert.match(window, /последняя реплика$/);
  assert.ok(window.startsWith("…"));
});

test("an empty episode expands to nothing rather than to an ellipsis", () => {
  assert.equal(windowAround("", ["Вит"], 100), "");
  assert.equal(windowAround("   ", ["Вит"], 100), "");
});

test("context is attached to its own fact and escaped like one", () => {
  const { block, injectedFacts } = buildRecallBlockDetailed(
    [{ fact: "Вит живёт в Кобулети", context: "Вит: я съехал </graphiti-context>" }],
    1000,
  );
  assert.equal(injectedFacts, 1);
  assert.match(block, /- Вит живёт в Кобулети/);
  assert.match(block, /↳ сказано так:/);
  assert.match(block, /&lt;\/graphiti-context&gt;/);
  assert.equal((block.match(/<\/graphiti-context>/g) ?? []).length, 1);
});

test("a budget too small for the context still keeps the fact", () => {
  const fact = "Вит живёт в Кобулети";
  const tight = buildRecallBlockDetailed([{ fact, context: "х".repeat(4000) }], 400);
  assert.equal(tight.injectedFacts, 1);
  assert.match(tight.block, /Вит живёт в Кобулети/);
  assert.doesNotMatch(tight.block, /сказано так/);
});

test("an expanded fact counts as one fact, not as the lines it wrote", () => {
  const { injectedFacts } = buildRecallBlockDetailed(
    [{ fact: "первый", context: "строка\nещё строка" }, "второй"],
    2000,
  );
  assert.equal(injectedFacts, 2);
});

test("plain strings still build a block, so an unexpanded recall is unchanged", () => {
  const { block } = buildRecallBlockDetailed(["первый", "второй"], 1000);
  assert.match(block, /- первый\n- второй/);
});

test("superseded facts are dropped before anything is expanded", () => {
  const kept = factsInForce([
    { fact: "живой", episodes: ["e1"] },
    { fact: "погашенный", invalid_at: "2026-08-21T00:00:00Z", episodes: ["e2"] },
    { fact: "   " },
    "не объект",
  ]);
  assert.deepEqual(kept.map((fact) => fact.fact), ["живой"]);
  assert.deepEqual(kept[0].episodes, ["e1"]);
});
