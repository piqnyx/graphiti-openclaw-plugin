import test from "node:test";
import assert from "node:assert/strict";
import { BufferEngine } from "../dist/buffer.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  assert.fail("condition was not met before timeout");
}

const agents = {
  main: { user: "Вит", assistant: "Краб" },
};

function addTurn(engine, agentId, sessionKey, n) {
  engine.addMessage(agentId, sessionKey, "user", `user-${n}`);
  engine.addMessage(agentId, sessionKey, "assistant", `assistant-${n}`);
}

test("one agent processing sequentially drains its whole queue in a single pass", async (t) => {
  const order = [];
  const gate = deferred();
  let released = 0;

  const engine = new BufferEngine(
    agents,
    2,
    3600, // bufferTimeout, сек (не влияет на limit-путь)
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
  await waitFor(() => order.length === 1, 2000);
  gate.resolve();
  await waitFor(() => order.length === 3, 2000);
  assert.deepEqual(order, ["a", "b", "c"]);

  assert.equal(released, 3);
});

test("a failing agent does not block another agent's flush (parallel across agents)", async (t) => {
  const flushes = [];
  const errors = [];
  const engine = new BufferEngine(
    agents,
    2,
    3600,
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

  await waitFor(() => flushes.some((f) => f.agentId === "broken"), 2000);
  await waitFor(() => errors.length === 1, 2000);

  // Здоровый агент продолжает работать независимо.
  addTurn(engine, "healthy", "h1", 1);
  engine.addMessage("healthy", "h1", "user", "u2");
  await waitFor(() => flushes.some((f) => f.agentId === "healthy"), 2000);

  const healthy = flushes.find((f) => f.agentId === "healthy");
  assert.deepEqual(healthy, { agentId: "healthy", sessionKey: "h1" });
  assert.equal(errors.length, 1, "only the broken agent reported an error");
  assert.equal(engine.queueLength(), 0);
});

test("single message buffer is never enqueued (no eligibility), stays alive", async (t) => {
  const flushes = [];
  const engine = new BufferEngine(
    agents,
    10,
    3600,
    async (_agentId, entry) => {
      flushes.push(entry.buffer.sessionKey);
    },
  );
  t.after(() => engine.stop());

  // Одиночное сообщение — не эпизод: не попадает в очередь и не эвакуируется.
  engine.addMessage("main", "empty", "user", "x");
  await sleep(150); // даём движку шанс ошибочно обработать (его не должно быть)
  assert.equal(flushes.length, 0, "single message must not be published");
  assert.equal(engine.queueLength(), 0, "nothing in the queue");
  assert.equal(engine.activeBufferCount("main"), 1, "buffer stays alive waiting");

  // Добиваем до пары → теперь буфер элиджибл (но реальный timeout-уход проверен
  // отдельно в buffer.test; здесь только подтверждаем, что пара стала элиджибл).
  engine.addMessage("main", "empty", "assistant", "y");
  assert.equal(engine.activeBufferCount("main"), 1);
});

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
