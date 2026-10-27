// Откуда факт: из дайджеста или из разговора (digest PLAN.md, этап 3; Вит 27.10: «отделять надо
// мы и дайджест»). Дайджест Эвы лежит в эпизоде сразу за подменой пусковика (правило графити
// digest-trigger: «Эва по своей инициативе рассказывает Виту новости дня»); факт из сообщения
// за ней -- из дайджеста (для чтения новостей это сюжет), из любого другого сообщения разговора,
// её или Вита, -- из разговора (перекличка). Метка вычисляется при чтении из эпизода, старые
// дайджесты с 17.10 метятся без правки данных.

import test from "node:test";
import assert from "node:assert/strict";
import { factOrigins } from "../dist/recall-expand.js";

const body = (messages) => JSON.stringify({ participants: { user: "Вит", assistant: "Эва" }, messages });
const MARKER = "Эва по своей инициативе рассказывает Виту новости дня";

const EPISODES = [
  {
    uuid: "e-digest",
    name: "saga-7",
    content: body([
      { role: "user", text: "я пошёл за водой" },
      { role: "user", text: `${MARKER}.` },
      { role: "assistant", text: "Политолог Кынев объявил голодовку в СИЗО-4 из-за сломанной ноги." },
      { role: "user", text: "жалко мужика, нормальный он" },
      { role: "assistant", text: "Да, ему сейчас тяжело." },
    ]),
  },
  {
    uuid: "e-talk",
    name: "saga-8",
    content: body([
      { role: "user", text: "слушай, вышел новый драйвер NVIDIA" },
      { role: "assistant", text: "Драйвер NVIDIA исправил вылеты в играх." },
    ]),
  },
];

// A digest that lay in the episode as several messages in a row (a tool called in the middle
// of the reply), and a talk where her answer came in two parts after his question.
EPISODES.push(
  {
    uuid: "e-split",
    name: "saga-9",
    content: body([
      { role: "user", text: `${MARKER}.` },
      { role: "assistant", text: "Начну с перемирия в Алешках: его продлили на сутки." },
      { role: "assistant", text: "А ещё адвокат Георгиевская подала жалобу на СИЗО-4 из-за досмотров." },
      { role: "user", text: "ого, про досмотры не знал" },
    ]),
  },
  {
    uuid: "e-talk-split",
    name: "saga-10",
    content: body([
      { role: "user", text: "что там с курсом биткоина?" },
      { role: "assistant", text: "Сейчас посмотрю." },
      { role: "assistant", text: "Биткоин вырос до девяноста тысяч долларов за неделю." },
    ]),
  },
);

function client(asked = []) {
  return {
    getEpisodesByRef: async (groupId, refs) => {
      asked.push({ groupId, refs });
      return EPISODES.filter((episode) => refs.uuids.includes(episode.uuid));
    },
  };
}

test("a fact drawn from the message right after the digest trigger is from a digest, any other is from the talk", async () => {
  const facts = [
    { fact: "Политолог Кынев объявил голодовку в СИЗО-4.", episodes: ["e-digest"] },
    { fact: "Виту жалко мужика, он нормальный.", episodes: ["e-digest"] },
    { fact: "Драйвер NVIDIA исправил вылеты в играх.", episodes: ["e-talk"] },
    { fact: "Без источника.", episodes: [] },
    { fact: "Эпизод пропал.", episodes: ["e-gone"] },
  ];
  const asked = [];
  const origins = await factOrigins(client(asked), "main", facts, [MARKER]);
  assert.deepEqual(origins, ["digest", "talk", "talk", null, null]);
  // One fetch for all the facts, in the agent's own graph.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].groupId, "main");
  assert.deepEqual(asked[0].refs.uuids, ["e-digest", "e-talk", "e-gone"]);
});

test("a fact drawn from the trigger itself is from the digest too", async () => {
  const origins = await factOrigins(client(), "main", [{ fact: "Эва по своей инициативе рассказывает Виту новости дня.", episodes: ["e-digest"] }], [MARKER]);
  assert.deepEqual(origins, ["digest"]);
});

test("without markers nothing is looked up and nothing is known", async () => {
  const asked = [];
  const origins = await factOrigins(client(asked), "main", [{ fact: "Политолог Кынев объявил голодовку.", episodes: ["e-digest"] }], []);
  assert.deepEqual(origins, [null]);
  assert.deepEqual(asked, []);
});


test("a digest is her whole reply after the trigger, however many messages it took", async () => {
  const facts = [
    { fact: "Адвокат Георгиевская подала жалобу на СИЗО-4 из-за досмотров.", episodes: ["e-split"] },
    { fact: "Вит не знал про досмотры.", episodes: ["e-split"] },
    { fact: "Биткоин вырос до девяноста тысяч долларов за неделю.", episodes: ["e-talk-split"] },
  ];
  assert.deepEqual(await factOrigins(client(), "main", facts, [MARKER]), ["digest", "talk", "talk"]);
});
