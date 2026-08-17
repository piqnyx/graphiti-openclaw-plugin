import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRecallBlockDetailed,
  buildRecallQuery,
  extractConversationMessages,
  sanitizeConversationText,
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

test("machine transcription is stored as speech, not as its provenance wrapper", () => {
  const captured = extractConversationMessages([
    { role: "user", content: '[Audio transcript (machine-generated, untrusted)]: "Привет, я Вит."' },
    { role: "user", content: '[Voice transcript (untrusted)]: "Он сказал "привет" и ушёл"' },
    { role: "assistant", content: "обычный ответ" },
  ]);

  assert.deepEqual(captured, [
    { role: "user", text: "Привет, я Вит." },
    { role: "user", text: 'Он сказал "привет" и ушёл' },
    { role: "assistant", text: "обычный ответ" },
  ]);
});

test("bracketed text that is not a transcription marker is left alone", () => {
  const captured = extractConversationMessages([
    { role: "user", content: "[TODO]: починить транскрипт" },
    { role: "user", content: 'сказал "[Audio transcript]: fake" в середине фразы' },
    { role: "user", content: "[Audio transcript (machine-generated, untrusted)]: без кавычек" },
  ]);

  assert.deepEqual(captured.map((m) => m.text), [
    "[TODO]: починить транскрипт",
    'сказал "[Audio transcript]: fake" в середине фразы',
    "без кавычек",
  ]);
});

test("TTS directives the model wrote into its own reply do not reach memory", () => {
  // The gateway strips these before the channel renders them, but capture reads
  // the model's raw output, so they arrive intact. Stored as-is, extraction would
  // mint entities out of voice ids and model names.
  const withParams = sanitizeConversationText(
    '[[tts:speakerVoiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]] Вит живёт в Григолети.',
  );
  assert.equal(withParams, "Вит живёт в Григолети.");

  // The audio-only block is speech the assistant actually uttered: the markers
  // go, the words stay — the same rule transcription markers follow.
  const withBlock = sanitizeConversationText(
    'Готово. [[tts:text]](laughs) Read the song once more.[[/tts:text]]',
  );
  assert.equal(withBlock, "Готово. (laughs) Read the song once more.");

  assert.equal(sanitizeConversationText("[[audio_as_voice]] Привет."), "Привет.");

  // Text that merely mentions the syntax in prose is not a directive.
  assert.equal(
    sanitizeConversationText("Скобки [[tts: тут не закрыты и это просто текст"),
    "Скобки [[tts: тут не закрыты и это просто текст",
  );
});

test("the gateway's own runtime context never reaches memory", () => {
  // Taken from a live capture: the block carries the chat id, the sender's
  // identity, session ids, and the recent traffic of OTHER sessions. Stored
  // verbatim it puts another conversation into this agent's episode.
  const captured = [
    "OpenClaw runtime context for the active user request in this turn.",
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
    'Conversation info: ⟦openclaw:ctx⟧ ```json {"chat_id":"telegram:1817786487","sender":{"username":"lux_datorr"}} ```',
    "#session:436aacb7 OpenClaw: Это хреново, горло — штука коварная.",
    "#session:b720425f OpenClaw: Солярка на машину — это реально, но есть нюансы.",
    "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    "Да, скорее всего умеют.",
    "Да, скорее всего умеют.",
  ].join("\n");

  const clean = sanitizeConversationText(captured);

  assert.equal(clean, "Да, скорее всего умеют.");
  for (const leak of ["telegram:1817786487", "lux_datorr", "session:436aacb7", "Солярка", "chat_id"]) {
    assert.ok(!clean.includes(leak), `${leak} must not survive sanitization`);
  }
});

test("a truncated context block does not leak the part that arrived", () => {
  // No closing marker: the message was cut. What is left is still the gateway's
  // internal state, so it goes too.
  const clean = sanitizeConversationText(
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nConversation info: chat_id telegram:999\n#session:aaa OpenClaw: чужое",
  );
  assert.equal(clean, "");
});

test("a genuine repetition inside a message is preserved", () => {
  // The duplicate collapse is deliberately narrow: only the whole text repeated
  // exactly once, which is what the gateway produces — not any repeated line.
  const text = "да\nда\nда";
  assert.equal(sanitizeConversationText(text), text);
  assert.equal(sanitizeConversationText("тест\nтест\nхвост"), "тест\nтест\nхвост");
});
