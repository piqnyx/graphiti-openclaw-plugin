# Buffer System — текущая архитектура Graphiti capture

Обновлено: 2026-08-15.

Этот документ описывает **текущее поведение кода**. Старые правила про обязательные пары `user+assistant`, чётный `bufferLimit` и отбрасывание user-only сообщений отменены.

## 1. Общая модель

Для каждого OpenClaw agent существует независимое capture-состояние:

```text
agent
├── session A -> active buffer
├── session B -> active buffer
├── session C -> active buffer
└── одна FIFO queue на agent
```

Инварианты:

- `group_id = agentId`;
- `saga = sessionKey`;
- один dialog/session = одна Graphiti Saga;
- буферы независимы по `agentId + sessionKey`;
- очередь одна на agent;
- внутри agent очередь строго FIFO;
- разные agents processятся независимо.

## 2. Что поступает из OpenClaw

Hook `agent_end` получает полный `messagesSnapshot`, а не только новую пару сообщений.
Поэтому plugin не может просто добавлять весь массив на каждом вызове: это создало бы дубликаты.

Capture pipeline:

```text
agent_end.messages snapshot
        ↓
оставить только role=user|assistant
        ↓
sanitize text
        ↓
TranscriptDeltaTracker(agentId, sessionKey)
        ↓
только новые сообщения относительно прошлого snapshot
        ↓
BufferEngine.addMessages(...)
```

`TranscriptDeltaTracker` хранит последний наблюдавшийся snapshot отдельно для каждой `agent/session`.

При первом наблюдении session после запуска plugin **не переигрывается вся старая история**. Берётся только текущий хвост разговора после предыдущей assistant-границы.

При compaction/rewrite tracker пытается найти надёжное пересечение старого хвоста с новым snapshot. Если пересечение не найдено, используется тот же консервативный current-tail fallback вместо повторной отправки всей истории.

## 3. Сообщение — атомарная единица capture

Буфер хранит сообщения ровно в наблюдаемом порядке:

```json
[
  { "role": "user", "text": "..." },
  { "role": "user", "text": "..." },
  { "role": "assistant", "text": "..." }
]
```

Никакого требования чередования ролей нет.

Нормальны все варианты:

```text
U A
U U A
U A U U U A
U U U U U U U A
A
U
```

Это намеренно. Реальный OpenClaw dialog может содержать несколько user-сообщений подряд из-за stop/abort/retry или поведения канала.

`event.success=false` сам по себе **не отбрасывает snapshot**. Если после остановки агента появился новый user message, он всё равно попадёт в capture delta.

Heartbeat, cron, subagent и slug-generator sessions отбрасываются раньше capture.

## 4. bufferLimit

`bufferLimit` — жёсткий максимум **количества сообщений в одном batch**.

Допустимо любое целое значение `1..1000`. Чётность не требуется.

При `bufferLimit=6`:

```text
U U U U U U U A
│───────────│ │─│
 batch 1=6    buffer 2=[U,A]
```

То есть первые шесть сообщений немедленно detach в queue, остальные продолжают новый buffer той же session.

Сообщения не пропадают и не требуют наличия соответствующего assistant.

## 5. bufferTimeout

`bufferTimeout` задаётся в секундах. Минимум 30 секунд.

Внутренний ticker равен 30 секундам.

Любой **непустой** active buffer eligible для timeout flush, включая одинокий user message.

Пример:

```text
session A -> [U,U,U,U]
switch to session B

через bufferTimeout без активности A:
A detach -> agent FIFO queue
```

Активность другой session не сбрасывает timeout первой.

Если при приходе нового сообщения старый buffer этой же session уже просрочен, старый buffer сначала detach, после чего новое сообщение идёт в новый buffer.

## 6. QueueEntry

```typescript
interface QueueEntry {
  buffer: Buffer;
  enqueuedAt: number;
}
```

`enqueuedAt` фиксируется в момент detach и используется как `reference_time` для Graphiti episode.

## 7. FIFO и ошибки transport/MCP

Failed queue head **не удаляется**.

```text
head EP7 -> failed
             ↓
          остаётся head
             ↓
retry через CHECK_INTERVAL_SEC
             ↓
success -> EP8 -> EP9
```

Для prepared episode caller UUID резервируется заранее и сохраняется до acceptance. Повтор transport-вызова использует тот же UUID.

Другие agents при этом не блокируются.

Ошибки capture публикуются как error-only plugin session status и логируются. UI-status path best-effort и не влияет на очередь.

## 8. Ошибки после MCP acceptance

`add_memory` возвращает acceptance до завершения асинхронной Graphiti обработки.

Graphiti fork предоставляет `get_queue_status(group_id)`. Plugin проверяет его каждые 30 секунд.

Если backend исчерпал retries и заблокировал agent group, plugin публикует error-only session status с безопасной диагностикой:

- `episode_uuid`;
- `episode_name`;
- `saga`;
- attempts;
- pending;
- error.

Conversation body в status не хранится.

Если health-check самого backend не отвечает, plugin сообщает, что persistence не может быть подтверждён.

## 9. Saga sequencing и restart recovery

Episode name:

```text
<tail session UUID>-<batchNumber>
```

Каждый следующий episode одной Saga получает predecessor предыдущего accepted episode:

```text
previous_episode_uuids = [lastEpisodeUuid]
saga_previous_episode_uuid = lastEpisodeUuid
```

Перед первым batch конкретной `agent/session` после запуска plugin вызывается:

```text
get_saga(saga_name=sessionKey, group_id=agentId)
```

Из Graphiti восстанавливаются:

- `episode_count`;
- `last_episode_uuid`.

Поэтому restart plugin не сбрасывает существующую Saga обратно в batch `-1`.

## 10. JSON episode

Буфер сразу содержит canonical participants для agent:

```json
{
  "participants": {
    "user": "Вит",
    "assistant": "Краб"
  },
  "messages": []
}
```

Каждое новое сообщение добавляется в `messages` после sanitization.

Перед capture удаляются memory injection blocks:

- `<graphiti-context>...</graphiti-context>`;
- `<openviking-context>...</openviking-context>`;
- `<relevant-memories>...</relevant-memories>`.

Graphiti и OpenViking не должны захватывать recall-output друг друга.

## 11. Текущая конфигурация buffer

```typescript
interface BufferConfig {
  bufferLimit: number;   // 1..1000 actual messages
  bufferTimeout: number; // seconds, 30..604800
}
```

Для текущего live-теста:

```json
{
  "bufferLimit": 6,
  "bufferTimeout": 300
}
```

## 12. In-memory граница

Active buffers, transcript delta snapshots и plugin-side FIFO queue находятся в памяти процесса OpenClaw.

Persisted Saga continuity после restart восстанавливается через Graphiti `get_saga`, но **ещё не отправленные active buffers** при аварийном restart процесса не являются durable storage. Это отдельная будущая задача, если понадобится crash-durable pre-MCP capture.
