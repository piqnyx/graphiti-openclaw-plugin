import test from "node:test";
import assert from "node:assert/strict";
import { BufferEngine } from "../dist/buffer.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
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

const participants = [
  { role: "user", name: "Вит", aliases: [] },
  { role: "assistant", name: "Краб", aliases: [] },
];

function addTurn(engine, agentId, sessionKey, n) {
  engine.addMessage(agentId, sessionKey, "user", `user-${n}`);
  engine.addMessage(agentId, sessionKey, "assistant", `assistant-${n}`);
}

test("limit trigger: full buffer detaches as one episode and continues in a fresh buffer", async (t) => {
  const flushes = [];
  const engine = new BufferEngine(participants, 2, 60_000, async (agentId, entry, reason) => {
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

  await waitFor(() => flushes.length === 1);
  assert.deepEqual(flushes[0], {
    agentId: "main",
    sessionKey: "s1",
    roles: ["user", "assistant"],
    reason: "limit",
  });
  // Новое сообщение живёт в свежем буфере той же сессии.
  assert.equal(engine.activeBufferCount("main"), 1);
});

test("eligibility: single message never publishes as an episode", async (t) => {
  const flushes = [];
  const engine = new BufferEngine(
    participants,
    50,
    30,
    async (_agentId, entry, reason) => {
      flushes.push({ count: entry.buffer.messages.length, reason });
    },
    { checkIntervalMs: 10 },
  );
  t.after(() => engine.stop());

  // Только user — одиночное сообщение, даже по таймауту не эпизод.
  engine.addMessage("main", "s1", "user", "only-user");
  await sleep(60);
  assert.equal(flushes.length, 0, "single message must not be published");
  assert.equal(engine.activeBufferCount("main"), 1, "buffer stays alive waiting");

  // Добиваем до пары → теперь эпизод уйдёт по таймауту.
  engine.addMessage("main", "s1", "assistant", "now-a-pair");
  await sleep(50); // даём таймауту (30мс) пройти после последней активности
  await waitFor(() => flushes.length === 1);
  assert.deepEqual(flushes[0], { count: 2, reason: "timeout" });
});

test("timeout detector detaches idle buffers via tick", async (t) => {
  const flushes = [];
  const engine = new BufferEngine(
    participants,
    10,
    40,
    async (_agentId, entry, reason) => {
      flushes.push({ roles: entry.buffer.messages.map((m) => m.role), reason });
    },
    { checkIntervalMs: 10 },
  );
  t.after(() => engine.stop());

  addTurn(engine, "main", "s1", 1);
  // Ждём три тика, чтобы таймаут (40мс) сработал в детекторе.
  await waitFor(() => flushes.length === 1);
  assert.deepEqual(flushes[0], { roles: ["user", "assistant"], reason: "timeout" });
});

test("buffers are isolated per session within an agent", async (t) => {
  const flushes = [];
  const engine = new BufferEngine(
    participants,
    2,
    60_000,
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
    participants,
    2,
    60_000,
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

  await waitFor(() => flushes.length === 1);
  gate.resolve();
  await waitFor(() => flushes.length === 2);
  assert.deepEqual(flushes, ["first", "second"]);
});

test("agents are isolated: one agent's buffer does not affect another", async (t) => {
  const flushes = [];
  const engine = new BufferEngine(
    participants,
    2,
    60_000,
    async (agentId, entry) => {
      flushes.push({ agentId, sessionKey: entry.buffer.sessionKey });
    },
  );
  t.after(() => engine.stop());

  addTurn(engine, "igor", "s1", 1);
  engine.addMessage("igor", "s1", "assistant", "a1"); // предел → igor эпизод
  addTurn(engine, "main", "s2", 2);

  await waitFor(() => flushes.some((f) => f.agentId === "igor"));
  assert.equal(flushes.some((f) => f.agentId === "main"), false, "main buffer not yet full");
  assert.equal(engine.activeBufferCount("main"), 1);
  assert.equal(engine.queueLength(), 0, "igor episode already drained; nothing queued");
});

test("failed sink drops buffer without retry or re-enqueue", async (t) => {
  const errors = [];
  const flushes = [];
  const engine = new BufferEngine(
    participants,
    2,
    60_000,
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

  await waitFor(() => flushes.length === 1);
  await sleep(20);
  // Отцепленный буфер удалён из очереди, НЕ возвращён в неё; ошибка залогирована.
  assert.equal(engine.queueLength(), 0);
  assert.deepEqual(errors, [{ agentId: "main", sessionKey: "s1", error: "backend down" }]);
});

test("single agent with 2+ sessions both timeout and process", async (t) => {
  const flushes = [];
  const engine = new BufferEngine(
    participants,
    50,
    30,
    async (_agentId, entry, reason) => {
      flushes.push({ sessionKey: entry.buffer.sessionKey, reason });
    },
    { checkIntervalMs: 10 },
  );
  t.after(() => engine.stop());

  addTurn(engine, "main", "s1", 1);
  addTurn(engine, "main", "s2", 2);

  await waitFor(() => flushes.length === 2);
  const order = flushes.map((f) => f.sessionKey).sort();
  assert.deepEqual(order, ["s1", "s2"]);
  assert.ok(flushes.every((f) => f.reason === "timeout"));
});
