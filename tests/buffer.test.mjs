import test from "node:test";
import assert from "node:assert/strict";
import { BufferEngine, CHECK_INTERVAL_SEC } from "../dist/buffer.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(250);
  }
  assert.fail("condition was not met before timeout");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const agents = {
  main: { user: "Вит", assistant: "Краб" },
};

function addTurn(engine, agentId, sessionKey, n) {
  engine.addMessage(agentId, sessionKey, "user", `user-${n}`);
  engine.addMessage(agentId, sessionKey, "assistant", `assistant-${n}`);
}

// Реальный тик = CHECK_INTERVAL_SEC (30c). Для timeout-тестов ждём с большим запасом,
// чтобы покрыть фазу тика (~ один полный интервал сверху).
const TIMEOUT_TEST_WINDOW_MS = (CHECK_INTERVAL_SEC * 2 + 10) * 1000;

test("limit trigger: full buffer detaches as one episode and continues in a fresh buffer", async (t) => {
  const flushes = [];
  const engine = new BufferEngine(agents, 2, 3600, async (agentId, entry, reason) => {
    flushes.push({
      agentId,
      sessionKey: entry.buffer.sessionKey,
      roles: entry.buffer.messages.map((m) => m.role),
      reason,
    });
  });
  t.after(() => engine.stop());

  // 1 ход = 2 сообщения = буфер полон (limit=2).
  addTurn(engine, "main", "s1", 1);
  // Следующее сообщение триггерит отцепление ПОЛНОГО буфера + новый буфер.
  engine.addMessage("main", "s1", "user", "user-2");

  await waitFor(() => flushes.length === 1, 2000);
  assert.deepEqual(flushes[0], {
    agentId: "main",
    sessionKey: "s1",
    roles: ["user", "assistant"],
    reason: "limit",
  });
  // Новое сообщение живёт в свежем буфере той же сессии.
  assert.equal(engine.activeBufferCount("main"), 1);
});

test("buffers are isolated per session within an agent", async (t) => {
  const flushes = [];
  const engine = new BufferEngine(
    agents,
    2,
    3600,
    async (_agentId, entry, reason) => {
      flushes.push({
        sessionKey: entry.buffer.sessionKey,
        roles: entry.buffer.messages.map((m) => m.role),
      });
    },
  );
  t.after(() => engine.stop());

  addTurn(engine, "main", "sA", 1);
  addTurn(engine, "main", "sB", 2);

  assert.equal(engine.activeBufferCount("main"), 2);
  assert.equal(flushes.length, 0, "no threshold hit when each session separately below limit");
});

test("FIFO queue per agent preserves chronological order", async (t) => {
  const flushes = [];
  const gate = deferred();
  // limit=2 → каждый ход сразу отцепляется, очередь формируется по порядку добавления сессий.
  const engine = new BufferEngine(
    agents,
    2,
    3600,
    async (_agentId, entry) => {
      flushes.push(entry.buffer.sessionKey);
      if (flushes.length === 1) await gate.promise; // держим первый, копим хвосты
    },
  );
  t.after(() => engine.stop());

  addTurn(engine, "main", "first", 1);
  engine.addMessage("main", "first", "user", "u2"); // предел → enqueue first
  addTurn(engine, "main", "second", 3);
  engine.addMessage("main", "second", "user", "u4"); // предел → enqueue second

  await waitFor(() => flushes.length === 1, 2000);
  gate.resolve();
  await waitFor(() => flushes.length === 2, 2000);
  assert.deepEqual(flushes, ["first", "second"]);
});

test("agents are isolated: one agent's buffer does not affect another", async (t) => {
  const flushes = [];
  const engine = new BufferEngine(
    agents,
    2,
    3600,
    async (agentId, entry) => {
      flushes.push({ agentId, sessionKey: entry.buffer.sessionKey });
    },
  );
  t.after(() => engine.stop());

  addTurn(engine, "igor", "s1", 1);
  engine.addMessage("igor", "s1", "assistant", "a1"); // предел → igor эпизод
  addTurn(engine, "main", "s2", 2);

  await waitFor(() => flushes.some((f) => f.agentId === "igor"), 2000);
  assert.equal(flushes.some((f) => f.agentId === "main"), false, "main buffer not yet full");
  assert.equal(engine.activeBufferCount("main"), 1);
  assert.equal(engine.queueLength(), 0, "igor episode already drained; nothing queued");
});

test("failed sink drops buffer without retry or re-enqueue", async (t) => {
  const errors = [];
  const flushes = [];
  const engine = new BufferEngine(
    agents,
    2,
    3600,
    async (agentId, entry) => {
      flushes.push(entry.buffer.sessionKey);
      throw new Error("backend down");
    },
    {
      notifyError: (agentId, sessionKey, reason, error) =>
        errors.push({ agentId, sessionKey, error: error.message }),
    },
  );
  t.after(() => engine.stop());

  addTurn(engine, "main", "s1", 1);
  engine.addMessage("main", "s1", "user", "u2"); // предел → enqueue → sink throws

  await waitFor(() => flushes.length === 1, 2000);
  await sleep(250);
  // Отцепленный буфер удалён из очереди, НЕ возвращён в неё; ошибка залогирована.
  assert.equal(engine.queueLength(), 0);
  assert.deepEqual(errors, [{ agentId: "main", sessionKey: "s1", error: "backend down" }]);
});

/**
 * Реальный интеграционный тест timeout-детекции: дожидаемся настоящего тика.
 *
 * - сессия A: только 1 сообщение (user) — по таймауту НЕ уходит (eligibility),
 *   буфер остаётся жив и ждёт второго сообщения.
 * - сессия B: пара user+assistant — по таймауту уходит в очередь и processится.
 *
 * Это покрывает eligibility gate (одиночное сообщение не эпизод) и сам
 * запуск отцепления по таймауту реальным таймером движка.
 */
test("timeout detection: single-message buffer waits, complete turn dispatches (real tick)", async (t) => {
  const flushes = [];
  const engine = new BufferEngine(
    agents,
    50,
    30, // bufferTimeout = 30 c — движок принимает секунды напрямую (не parseConfig)
    async (_agentId, entry, reason) => {
      flushes.push({ sessionKey: entry.buffer.sessionKey, count: entry.buffer.messages.length, reason });
    },
  );
  t.after(() => engine.stop());

  engine.addMessage("main", "session-a", "user", "одиночное-без-ответа");
  addTurn(engine, "main", "session-b", 1);

  // Ждём, пока реальный тик (до ~30-70с) отцепит пару session-b.
  await waitFor(() => flushes.some((f) => f.sessionKey === "session-b"), TIMEOUT_TEST_WINDOW_MS);

  const dispatched = flushes.find((f) => f.sessionKey === "session-b");
  assert.deepEqual(
    { sessionKey: dispatched.sessionKey, count: dispatched.count, reason: dispatched.reason },
    { sessionKey: "session-b", count: 2, reason: "timeout" },
  );

  // Одиночное сообщение session-a НЕ ушло и не собиралось в очередь.
  assert.equal(flushes.some((f) => f.sessionKey === "session-a"), false, "single message must not publish");
  assert.equal(engine.activeBufferCount("main"), 1, "session-a buffer stays alive waiting");

  // Добиваем session-a до пары → уйдёт на следующем тике.
  engine.addMessage("main", "session-a", "assistant", "теперь-пара");
  await waitFor(() => flushes.some((f) => f.sessionKey === "session-a"), TIMEOUT_TEST_WINDOW_MS);
  const a = flushes.find((f) => f.sessionKey === "session-a");
  assert.equal(a.count, 2);
  assert.equal(a.reason, "timeout");
});
