import test from "node:test";
import assert from "node:assert/strict";
import { bestMessage, excerptAround, factSources } from "../dist/recall-expand.js";
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

test("the excerpt keeps whole messages and says where it was cut", () => {
  const excerpt = excerptAround(conversation, 2, 150);
  assert.match(excerpt, /\[Вит\] в 14 лет Basic/);
  assert.match(excerpt, /^…\n/, `нет отметки об опущенном сверху:\n${excerpt}`);
  assert.match(excerpt, /\n…$/, `нет отметки об опущенном снизу:\n${excerpt}`);
});

test("a message too long for the budget loses its middle, not its ends", () => {
  const long = episodeMessages(body([{ role: "user", text: `начало ${"х".repeat(2000)} конец` }]));
  const excerpt = excerptAround(long, 0, 200);
  assert.ok(excerpt.length < 260, `бюджет превышен: ${excerpt.length}`);
  assert.match(excerpt, /начало/);
  assert.match(excerpt, /конец$/);
  assert.match(excerpt, /\(…omitted…\)/);
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
