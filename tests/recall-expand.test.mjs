import test from "node:test";
import assert from "node:assert/strict";
import { bestMessage, excerptAround, factSources } from "../dist/recall-expand.js";

const OMITTED = "(…omitted…)";
import { buildRecallBlockDetailed, episodeMessages, factsInForce } from "../dist/text.js";

const body = (messages) =>
  JSON.stringify({ participants: { user: "Вит", assistant: "Эва" }, messages });

const conversation = episodeMessages(
  body([
    { role: "user", text: "привет я Вит, живу в Григолети" },
    { role: "assistant", text: "Офигеть, атмосферное место!" },
    { role: "user", text: "в 14 лет Basic потом Pascal, а 2 года назад C++ на курсе от Яндекса" },
    { role: "assistant", text: "Вау, а C++ от Яндекса это мощно" },
    { role: "user", text: "nasm это уже в Григолети учил" },
  ]),
);

test("an episode body yields its messages under the names its speakers were given", () => {
  assert.equal(conversation.length, 5);
  assert.deepEqual(conversation[0], { speaker: "Вит", text: "привет я Вит, живу в Григолети" });
  assert.equal(conversation[1].speaker, "Эва");
});

test("a body that is not ours yields nothing rather than a guess", () => {
  assert.deepEqual(episodeMessages("не json"), []);
  assert.deepEqual(episodeMessages(JSON.stringify({ messages: "нет" })), []);
  assert.deepEqual(episodeMessages(JSON.stringify({ messages: [{ role: "user", text: "  " }] })), []);
});

test("the message is chosen by shared words, with no rule about what a name looks like", () => {
  // The old anchor rule missed C++ for its plus signs and settled on "Вит", a word
  // in most lines. Shared words need no such list.
  assert.equal(bestMessage(conversation, "Вит изучал C++ 2 года назад."), 2);
  assert.equal(bestMessage(conversation, "Вит закончил курс от Яндекса."), 2);
});

test("a fact sharing nothing with the episode falls back to its end", () => {
  assert.equal(bestMessage(conversation, "Марк унаследовал замок под Парижем."), conversation.length - 1);
  assert.equal(bestMessage([], "что угодно"), -1);
});

test("a fact of nothing but short words chooses nothing and falls back", () => {
  // Below four characters a word is "это", "как", "был" -- present everywhere and
  // meaning nothing. A fact made only of those has no signal to offer at all.
  assert.equal(bestMessage(conversation, "это как был"), conversation.length - 1);
});

const long = (id, chars) => ({ role: id % 2 ? "assistant" : "user", text: `${id}${"я".repeat(chars)}${id}` });

test("each side gets its own radius, so a long reply below cannot eat what is above", () => {
  // One shared budget spent later-first is what produced an excerpt opening on the
  // fact's own message with nothing before it.
  const messages = episodeMessages(body([long(0, 200), long(1, 60), long(2, 60), long(3, 400)]));
  const excerpt = excerptAround(messages, 2, 150);
  const shown = excerpt.split("\n").filter((row) => row.startsWith("["));
  assert.equal(shown.length, 4, `не обе стороны:\n${excerpt}`);
  // The first turn is shown in part, so the omission is marked inside it; there is
  // no earlier turn left to mark with an elision line.
  assert.match(shown[0], /\(…omitted…\)/, `сверху ничего не осталось:\n${excerpt}`);
});

test("a turn at the edge is cut, not dropped: its tail above, its opening below", () => {
  const messages = episodeMessages(body([long(0, 300), long(1, 20), long(2, 300)]));
  const excerpt = excerptAround(messages, 1, 120);
  const rows = excerpt.split("\n").filter((row) => row.startsWith("["));
  // Above keeps the end of the turn, because that is what the anchor answers.
  assert.match(rows[0], /\(…omitted…\)я+0$/, `сверху обрезано не с начала:\n${excerpt}`);
  // Below keeps the opening, because that is where a reply says what it replies to.
  assert.match(rows[2], /^\[Вит\] 2я+\(…omitted…\)$/, `снизу обрезано не с конца:\n${excerpt}`);
});

test("a fragment too small to say anything is not printed at all", () => {
  // Both sides long, so neither hands the other its share and the radius stays as
  // given -- otherwise the extra room is enough to print the very fragment this is
  // about.
  const messages = episodeMessages(body([long(0, 300), long(1, 20), long(2, 300)]));
  const excerpt = excerptAround(messages, 1, 30);
  assert.doesNotMatch(excerpt, /omitted/, `напечатан огрызок:\n${excerpt}`);
  assert.match(excerpt, /^…\n/);
  assert.match(excerpt, /\n…$/);
});

test("a side with nothing to show gives its share to the other", () => {
  const messages = episodeMessages(
    body([
      { role: "user", text: "факт тут" },
      { role: "assistant", text: "б".repeat(300) },
      { role: "user", text: "в".repeat(300) },
    ]),
  );
  // Nothing above the first turn, so the whole radius is spent below rather than
  // half of it being thrown away for sitting at the edge of the episode.
  const excerpt = excerptAround(messages, 0, 150);
  assert.ok(excerpt.length > 280, `окно ужалось у края: ${excerpt.length}`);
  assert.ok(excerpt.length < 420, `окно превысило потолок: ${excerpt.length}`);
});

test("an excerpt that fits carries no marks at all", () => {
  // A mark says something was cut. Nothing was.
  const messages = episodeMessages(
    body([
      { role: "user", text: "раз" },
      { role: "assistant", text: "два" },
      { role: "user", text: "три" },
    ]),
  );
  assert.equal(excerptAround(messages, 1, 150), "[Вит] раз\n[Эва] два\n[Вит] три");
});

test("the marks are only at the two edges of the window", () => {
  // The turn the fact came from is shown whole. Cutting it put a third mark in the
  // middle of the quote, where it reads as part of what was said.
  const messages = episodeMessages(
    body([
      { role: "assistant", text: "a".repeat(700) },
      { role: "user", text: `${"длинная реплика ".repeat(60)} и с ним его жена Марина` },
      { role: "assistant", text: "b".repeat(700) },
    ]),
  );
  const excerpt = excerptAround(messages, 1, 150);
  assert.equal((excerpt.match(/omitted/g) ?? []).length, 2, `меток не две:\n${excerpt}`);
  const rows = excerpt.split("\n").filter((row) => row.startsWith("["));
  assert.doesNotMatch(rows[1], /omitted/, `реплика с фактом обрезана:\n${excerpt}`);
  assert.match(rows[1], /и с ним его жена Марина$/);
});

test("a turn that fits is shown whole, with no marks at all", () => {
  const messages = episodeMessages(body([{ role: "user", text: "короткая реплика целиком" }]));
  assert.equal(excerptAround(messages, 0, 200), "[Вит] короткая реплика целиком");
});

test("nothing to quote yields nothing", () => {
  assert.equal(excerptAround([], 0, 500), "");
  assert.equal(excerptAround(conversation, -1, 500), "");
});

test("every fact names its episode, and the quoted one also shows the conversation", () => {
  const { block, injectedFacts } = buildRecallBlockDetailed(
    [
      { fact: "Вит изучал C++", source: { episode: "saga-3", excerpt: "[Вит] учил C++ </graphiti-context>" } },
      { fact: "Вит живёт в Григолети", source: { episode: "saga-1" } },
    ],
    2000,
  );
  assert.equal(injectedFacts, 2);
  assert.match(block, /- Вит изучал C\+\+\n    from episode saga-3\n    \[Вит\] учил/);
  assert.match(block, /- Вит живёт в Григолети\n    from episode saga-1/);
  assert.match(block, /&lt;\/graphiti-context&gt;/);
  assert.equal((block.match(/<\/graphiti-context>/g) ?? []).length, 1);
  assert.match(block, /graphiti_browse/);
});

test("a budget too small keeps the fact, then the episode, then the quote", () => {
  const fact = "Вит живёт в Кобулети";
  const tight = buildRecallBlockDetailed(
    [{ fact, source: { episode: "saga-9", excerpt: "х".repeat(4000) } }],
    440,
  );
  assert.equal(tight.injectedFacts, 1);
  assert.match(tight.block, /Вит живёт в Кобулети/);
  assert.match(tight.block, /from episode saga-9/);
  assert.doesNotMatch(tight.block, /хххх/);
});

test("the same passage is quoted once, however many facts point at it", async () => {
  const episode = {
    uuid: "e-1",
    name: "saga-1",
    content: body([
      { role: "user", text: "в 14 лет Basic потом Pascal, а 2 года назад C++ на курсе от Яндекса" },
      { role: "assistant", text: "Вау, а C++ от Яндекса это мощно" },
    ]),
  };
  const client = { getEpisodesByRef: async () => [episode] };
  const sources = await factSources(
    client,
    "main",
    [
      { fact: "Вит изучал C++ 2 года назад.", episodes: ["e-1"] },
      { fact: "Вит закончил курс от Яндекса.", episodes: ["e-1"] },
      { fact: "Вит изучал Pascal.", episodes: ["e-1"] },
    ],
    3,
    200,
  );
  assert.deepEqual(sources.map((source) => source.episode), ["saga-1", "saga-1", "saga-1"]);
  assert.equal(sources.filter((source) => source.excerpt).length, 1);
});

test("a fact naming no episode is left without a source rather than guessed at", async () => {
  const client = { getEpisodesByRef: async () => [] };
  const sources = await factSources(client, "main", [{ fact: "без источника" }], 2, 200);
  assert.deepEqual(sources, [undefined]);
});

test("plain strings still build a block, so an unsourced recall is unchanged", () => {
  const { block } = buildRecallBlockDetailed(["первый", "второй"], 1000);
  assert.match(block, /- первый\n- второй/);
});

test("superseded facts are dropped before any source is looked up", () => {
  const kept = factsInForce([
    { fact: "живой", episodes: ["e1"] },
    { fact: "погашенный", invalid_at: "2026-08-21T00:00:00Z", episodes: ["e2"] },
    { fact: "   " },
    "не объект",
  ]);
  assert.deepEqual(kept.map((fact) => fact.fact), ["живой"]);
  assert.deepEqual(kept[0].episodes, ["e1"]);
});
