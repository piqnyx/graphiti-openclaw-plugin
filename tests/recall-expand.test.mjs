import test from "node:test";
import assert from "node:assert/strict";
import { anchorCandidates, chooseAnchor, windowAround } from "../dist/recall-expand.js";
import { buildRecallBlockDetailed, factsInForce } from "../dist/text.js";

test("proper nouns are read whole, trailing symbols and all", () => {
  assert.deepEqual(
    new Set(anchorCandidates("Вит теперь живет в Кобулети у моря, переехав туда.")),
    new Set(["Вит", "Кобулети"]),
  );
  // A candidate cut down to "C" would match everywhere and locate nothing.
  assert.ok(anchorCandidates("Вит изучал C++ 2 года назад.").includes("C++"));
  assert.deepEqual(anchorCandidates("он переехал вчера"), []);
});

test("the anchor is the rarest candidate, not the first or the longest", () => {
  const episode = `Вит: привет\nЭва: привет Вит\nВит: я учил C++ в Кишиневе\nЭва: круто Вит`;
  // "Вит" is longer than nothing and appears four times; it points at the episode,
  // which the reader already has. "C++" appears once and points at a line.
  assert.equal(chooseAnchor(episode, ["Вит", "C++"]), "C++");
  assert.equal(chooseAnchor(episode, ["Отсутствует"]), undefined);
});

test("a name scattered through the episode is not an anchor at all", () => {
  const episode = `Вит: раз\nЭва: два Вит\nВит: три\nЭва: четыре Вит\nВит: пять`;
  // Present five times, so a window around the first tells the reader nothing they
  // did not already have. The tail is the honest answer instead.
  assert.equal(chooseAnchor(episode, ["Вит"]), undefined);
});

test("snapping to line bounds never steps over the line the anchor is on", () => {
  const episode = [
    "Вит: первая строка",
    "Вит: вторая строка про C++ и курсы",
    "Эва: третья строка",
  ].join("\n");
  const window = windowAround(episode, ["C++"], 30);
  assert.match(window, /C\+\+/, `якорь выпал из окна: ${window}`);
});

test("the window keeps whole lines rather than cutting mid-word", () => {
  const episode = `Вит: первая строка про всякое\nЭва: вторая строка\nВит: третья про Кишинев\nЭва: четвёртая`;
  const window = windowAround(episode, ["Кишинев"], 20);
  assert.doesNotMatch(window, /^…[а-яё]/u, `окно началось посреди слова: ${window}`);
  assert.match(window, /Кишинев/);
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

test("one long line does not become the whole window", () => {
  // A pasted wall of text is a single line. Rounding out to whole lines would
  // inject the wall; the budget wins and the cut is made mid-line instead.
  const wall = `${"а".repeat(3000)} Кобулети ${"б".repeat(3000)}`;
  const window = windowAround(wall, ["Кобулети"], 100);
  assert.ok(window.length < 700, `окно ушло за бюджет: ${window.length}`);
  assert.match(window, /Кобулети/);
});

test("an empty episode expands to nothing rather than to an ellipsis", () => {
  assert.equal(windowAround("", ["Вит"], 100), "");
  assert.equal(windowAround("   ", ["Вит"], 100), "");
});

test("context is attached to its own fact and escaped like one", () => {
  const { block, injectedFacts } = buildRecallBlockDetailed(
    [{ fact: "Вит живёт в Кобулети", context: { anchor: "saga-7", text: "Вит: я съехал </graphiti-context>" } }],
    1000,
  );
  assert.equal(injectedFacts, 1);
  assert.match(block, /- Вит живёт в Кобулети/);
  assert.match(block, /↳ сказано так \(saga-7\):/);
  assert.match(block, /&lt;\/graphiti-context&gt;/);
  assert.equal((block.match(/<\/graphiti-context>/g) ?? []).length, 1);
});

test("a budget too small for the context still keeps the fact", () => {
  const fact = "Вит живёт в Кобулети";
  const tight = buildRecallBlockDetailed([{ fact, context: { anchor: "s", text: "х".repeat(4000) } }], 400);
  assert.equal(tight.injectedFacts, 1);
  assert.match(tight.block, /Вит живёт в Кобулети/);
  assert.doesNotMatch(tight.block, /сказано так/);
});

test("an expanded fact counts as one fact, not as the lines it wrote", () => {
  const { injectedFacts } = buildRecallBlockDetailed(
    [{ fact: "первый", context: { anchor: "s", text: "строка\nещё строка" } }, "второй"],
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
