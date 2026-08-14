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

const participants = [
  { role: "user", name: "Вит", aliases: [] },
  { role: "assistant", name: "Краб", aliases: [] },
];

function addTurn(engine, agentId, sessionKey, n) {
  engine.addMessage(agentId, sessionKey, "user", `user-${n}`);
  engine.addMessage(agentId, sessionKey, "assistant", `assistant-${n}`);
}

test("one agent processing sequentially drains its whole queue in a single pass", async (t) => {
  const order = [];
  const gate = deferred();
  let released = 0;

  const engine = new BufferEngine(
    participants,
    2,
    60_000,
    async (_agentId, entry) => {
      order.push(entry.buffer.sessionKey);
      if (order.length < 3) await gate.promise; // держим первый, чтобы хвосты накопились
      released += 1;
    },
  );
  t.after(() => engine.stop());

  // Формируем 3 заполненных буфера в очереди одного агента.
  for (const s of ["a", "b", "c"]) {
    addTurn(engine, "main", s, 1);
    engine.addMessage("main", s, "user", "u2");
  }

  // Снимаем gate: очередь агента должна опустошиться за один pass, строго по порядку.
  await waitFor(() => order.length === 1);
  gate.resolve();
  await waitFor(() => order.length === 3);
  assert.deepEqual(order, ["a", "b", "c"]);

  assert.equal(released, 3);
  engine.stop();
});

test("a failing agent does not block another agent's flush (parallel across agents)", async (t) => {
  const flushes = [];
  const errors = [];
  const engine = new BufferEngine(
    participants,
    2,
    60_000,
    async (agentId, entry) => {
      flushes.push({ agentId, sessionKey: entry.buffer.sessionKey });
      if (agentId === "broken") throw new Error("backend unavailable for broken agent");
    },
    {
      notifyError: (agentId, sessionKey, reason, error) =>
        errors.push({ agentId, sessionKey, error: error.message }),
    },
  );
  t.after(() => engine.stop());

  // Сначала «сломаный» агент — его очередь падает.
  addTurn(engine, "broken", "b1", 1);
  engine.addMessage("broken", "b1", "user", "u2"); // limit → enqueue → sink throws

  await waitFor(() => flushes.some((f) => f.agentId === "broken"));
  await waitFor(() => errors.length === 1);

  // Здоровый агент продолжает работать независимо.
  addTurn(engine, "healthy", "h1", 1);
  engine.addMessage("healthy", "h1", "user", "u2");
  await waitFor(() => flushes.some((f) => f.agentId === "healthy"));

  const healthy = flushes.find((f) => f.agentId === "healthy");
  assert.deepEqual(healthy, { agentId: "healthy", sessionKey: "h1" });
  assert.equal(errors.length, 1, "only the broken agent reported an error");
  assert.equal(engine.queueLength(), 0);
  engine.stop();
});

test("single-skill buffer waits for the second message instead of publishing", async (t) => {
  const flushes = [];
  const engine = new BufferEngine(
    participants,
    10,
    30,
    async (_agentId, entry) => {
      flushes.push(entry.buffer.sessionKey);
    },
    { checkIntervalMs: 10 },
  );
  t.after(() => engine.stop());

  // Буфер создан, но ни одного сообщения — после таймаута его тихо убирают.
  engine.addMessage("main", "empty", "user", "x"); // 1 сообщение — не эпизод
  await sleep(60);
  assert.equal(flushes.length, 0);
  // Буфер с одиночным сообщением живёт (eligibility), но после завершения пары уйдёт.
  engine.addMessage("main", "empty", "assistant", "y");
  await sleep(50); // ждём, пока таймаут (30мс) покроет пару
  await waitFor(() => flushes.length === 1);
  assert.deepEqual(flushes, ["empty"]);
  engine.stop();
});

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
