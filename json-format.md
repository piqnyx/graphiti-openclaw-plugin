# Формат JSON для `add_memory`

Обновлено: 2026-08-15.

## Episode body

Plugin отправляет Graphiti `source="json"` со следующим body:

```json
{
  "participants": {
    "user": "Вит",
    "assistant": "Краб"
  },
  "messages": [
    { "role": "user", "text": "Привет" },
    { "role": "user", "text": "Ты завис?" },
    { "role": "assistant", "text": "Уже отвечаю" }
  ]
}
```

`participants` задаёт canonical actor names для конкретного OpenClaw agent. Они берутся из `config.agents[agentId]`.

`messages` — обычная последовательность фактически наблюдавшихся conversation messages. Допустимые роли:

- `user`;
- `assistant`.

Чередование ролей **не требуется**. Несколько `user` подряд, несколько `assistant` подряд и batch только с одной ролью являются валидными.

## Capture source

`agent_end` OpenClaw передаёт полный transcript snapshot. Plugin:

1. оставляет только `user|assistant`;
2. извлекает текстовые content blocks;
3. sanitizes memory-injection wrappers и служебную metadata;
4. через per-session `TranscriptDeltaTracker` вычисляет только новые сообщения;
5. добавляет новые сообщения по одному в buffer.

Поэтому предыдущая история не должна повторно попадать в следующие episodes.

При первом наблюдении session после запуска plugin используется только current conversation tail, а не вся старая transcript history.

## Sanitization

До помещения в JSON удаляются:

```text
<graphiti-context>...</graphiti-context>
<openviking-context>...</openviking-context>
<relevant-memories>...</relevant-memories>
```

Также удаляются известные OpenClaw conversation/sender metadata wrappers, leading timestamp и NUL.

В коде **нет alias regex normalization**. Canonical actor names задаются только через `participants`.

## Batch boundaries

`bufferLimit` считает **реальные сообщения**, а не пары/turns.

При `bufferLimit=6` последовательность:

```text
U U U U U U U A
```

становится:

```text
batch 1: U U U U U U
batch 2: U A
```

Второй batch затем либо дополнится новыми сообщениями, либо уйдёт по timeout.

Любой непустой buffer может быть отправлен по timeout, включая один `user` без ответа assistant.

## Параметры `add_memory`

Plugin передаёт:

| параметр | значение |
|---|---|
| `uuid` | caller-reserved UUID episode |
| `name` | `<session UUID tail>-<batchNumber>` |
| `episode_body` | JSON выше |
| `group_id` | `agentId` |
| `source` | `json` |
| `source_description` | `OpenClaw conversation batch` |
| `saga` | `sessionKey` |
| `reference_time` | `QueueEntry.enqueuedAt` в ISO-8601 |
| `previous_episode_uuids` | пусто для первого episode, затем `[lastEpisodeUuid]` |
| `saga_previous_episode_uuid` | отсутствует для первого, затем `lastEpisodeUuid` |
| `custom_extraction_instructions` | внутренний prompt plugin для разбора `messages` ARRAY |

Caller UUID генерируется до MCP request и сохраняется до acceptance. Transport retry одного queue entry использует тот же UUID.

## Custom extraction instructions

Custom extraction prompt **используется**. Причина проста: actual conversation text вложен в `messages[]`, поэтому extractor явно инструктируется читать этот массив и учитывать canonical participants.

Пользователь не задаёт этот prompt через config; это внутренний контракт plugin.

## reference_time

`reference_time` равен времени detach buffer в agent FIFO queue (`enqueuedAt`), а не времени фактической обработки backend worker.

Это timestamp всего episode batch. Отдельных timestamp на каждое сообщение JSON сейчас не содержит.

## Saga continuity

Одна OpenClaw session = одна Graphiti Saga.

После restart plugin перед первым новым batch вызывает `get_saga(saga_name, group_id)` и восстанавливает `episode_count` и `last_episode_uuid`. Поэтому numbering и NEXT_EPISODE continuity продолжаются с persisted состояния Graphiti.
