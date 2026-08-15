# Graphiti OpenClaw Plugin — техническое задание

Статус: действующий технический контракт проекта.
Дата актуализации: 2026-08-15.

Этот документ является единственным авторитетным описанием текущей архитектуры plugin и ближайшего этапа разработки. Исторические эксперименты не должны возвращаться в production-код только потому, что они встречаются в старых commit/PR.

## 1. Назначение

`graphiti-openclaw-plugin` — slot-less companion plugin для OpenClaw. Он обеспечивает:

- автоматический capture conversation messages в Graphiti;
- автоматический recall фактов из Graphiti;
- строгую изоляцию данных разных OpenClaw agents;
- общую долговременную память между разными sessions одного и того же agent;
- детерминированную Saga-структуру для хронологии конкретной session;
- устойчивость capture к transport/MCP ошибкам и видимость terminal backend failures;
- отсутствие прямой зависимости от OpenViking.

Plugin не занимает `memory` или `contextEngine` slot OpenClaw и не управляет lifecycle Graphiti/FalkorDB/OpenViking.

## 2. Базовая модель identity и памяти

Главный инвариант:

```text
OpenClaw agentId == Graphiti group_id == physical Falkor graph name
```

Примеры:

```text
agent main  -> group_id main  -> Falkor graph main
agent igor  -> group_id igor  -> Falkor graph igor
```

### 2.1 Sessions и Saga

Каждая OpenClaw session внутри agent имеет собственную Graphiti Saga:

```text
agent main / session A -> saga A
agent main / session B -> saga B
agent main / session C -> saga C
```

Saga нужна для хронологии конкретного диалога, но **не является границей памяти для recall**.

Следовательно:

- факт из session A агента `main` должен быть доступен recall из session B агента `main`;
- факт из `main` не должен быть доступен agent `igor`;
- recall намеренно фильтруется по `group_id`, а не по Saga.

Это одна из базовых целей проекта и не должна быть случайно «усилена» до session-level isolation.

## 3. Capture source и transcript delta

OpenClaw `agent_end` передаёт transcript snapshot, а не гарантированно только новое сообщение/turn.

Capture pipeline:

1. до работы с transcript отклоняются heartbeat, cron, subagent/background и slug-generator runs;
2. из snapshot остаются только `role=user|assistant`;
3. text content извлекается и sanitizes;
4. удаляются raw memory-injection blocks и известная OpenClaw metadata;
5. `TranscriptDeltaTracker(agentId, sessionKey)` вычисляет только новые сообщения относительно предыдущего snapshot этой session;
6. каждое новое сообщение отдельно добавляется в `BufferEngine`.

`event.success=false` не является причиной выбрасывать transcript delta. Это необходимо для сценария:

```text
U -> agent завис -> STOP -> U -> STOP -> U -> A
```

Новые user messages должны сохраниться даже при aborted/failed run.

В capture больше нет понятия обязательной пары `user+assistant` или completed turn. Допустимы:

```text
U A
U U A
U U U U
A A
одинокий U
```

## 4. Sanitization и canonical actors

Перед capture удаляются raw blocks:

```text
<graphiti-context>...</graphiti-context>
<openviking-context>...</openviking-context>
<relevant-memories>...</relevant-memories>
```

Также удаляются известные conversation/sender metadata wrappers, leading timestamp и NUL.

Alias-regex normalization отсутствует. Canonical actor names задаются только через:

```text
config.agents[agentId].user
config.agents[agentId].assistant
```

## 5. Episode JSON

Graphiti вызывается с `source="json"`.

Episode body:

```json
{
  "participants": {
    "user": "Вит",
    "assistant": "Краб"
  },
  "messages": [
    { "role": "user", "text": "..." },
    { "role": "user", "text": "..." },
    { "role": "assistant", "text": "..." }
  ]
}
```

Role alternation не требуется.

Plugin передаёт внутренний `custom_extraction_instructions`, потому что реальный conversation text вложен в `messages[]`. Extraction prompt обязан явно заставлять Graphiti читать каждый `messages[].text` и учитывать canonical participants.

## 6. Buffer и batching

`bufferLimit` — количество фактических conversation messages в batch.

Допустимый диапазон:

```text
1..1000
```

Чётность не требуется.

При `bufferLimit=6`:

```text
U U U U U U U A
```

становится:

```text
batch 1 = U U U U U U
buffer 2 = U A
```

Любой непустой buffer eligible для timeout flush, включая одинокий `U`.

`bufferTimeout` задаётся в секундах. Минимум 30 секунд. Operational ticker равен 30 секундам.

Для текущего live acceptance используется:

```json
{
  "bufferLimit": 6,
  "bufferTimeout": 300
}
```

### 6.1 QueueEntry

Detach создаёт immutable operational entry:

```typescript
interface QueueEntry {
  buffer: Buffer;
  enqueuedAt: number;
  reason: "limit" | "timeout";
}
```

`reason` и `enqueuedAt` фиксируются в момент detach и не вычисляются заново при retry.

`reference_time` Graphiti episode = `QueueEntry.enqueuedAt` в ISO-8601.

## 7. FIFO и concurrency

- один active buffer на `agentId + sessionKey`;
- одна FIFO processing queue на agent;
- sessions одного agent могут наполняться независимо, но detached batches не обгоняют queue head;
- разные agents processятся независимо и могут работать параллельно.

## 8. Saga sequencing

Для каждой пары `agentId + sessionKey` поддерживается sequence state.

Episode name:

```text
<tail session UUID>-<1-based batchNumber>
```

Перед MCP submission caller UUID резервируется заранее.

Первый episode Saga:

```text
previous_episode_uuids = []
saga_previous_episode_uuid = отсутствует
```

Каждый следующий:

```text
previous_episode_uuids = [lastAcceptedEpisodeUuid]
saga_previous_episode_uuid = lastAcceptedEpisodeUuid
```

Graphiti fork физически создаёт chronology edge:

```text
EP1 -[:NEXT_EPISODE]-> EP2 -[:NEXT_EPISODE]-> EP3
```

Обратное физическое `NEXT_EPISODE` добавлять нельзя. Reverse traversal выполняется Cypher-запросом по существующему directed edge.

### 8.1 Restart recovery

После restart plugin перед первым новым batch конкретной session вызывает:

```text
get_saga(saga_name=sessionKey, group_id=agentId)
```

и восстанавливает:

- `episode_count`;
- `last_episode_uuid`.

После этого numbering и predecessor chain продолжаются с persisted Graphiti state.

## 9. Capture failure semantics

### 9.1 Ошибка до MCP acceptance

Transport/HTTP/MCP/get_saga/invalid-response failure:

- не удаляет FIFO head;
- не двигает sequence;
- сохраняет caller UUID;
- сохраняет QueueEntry reason/content/reference time;
- повторяется автоматически после operational retry interval;
- публикует best-effort error-only plugin session status.

Поздние batches не могут обогнать failed head.

### 9.2 Ошибка после MCP acceptance

`add_memory -> queued` не считается доказательством persistence, потому что Graphiti processing асинхронный.

Graphiti fork предоставляет:

```text
get_queue_status(group_id)
```

Plugin polling выполняется раз в 30 секунд.

Terminal backend failure после исчерпания Graphiti retries публикует error-only session status. Status может содержать безопасную диагностику episode UUID/name, saga, attempts, pending и error, но не conversation body.

Если health-check backend не отвечает, plugin сообщает, что persistence не может быть подтверждён. Уже доказанный `blocked` status не должен затираться менее информативной health-check ошибкой.

UI/status путь best-effort и не должен влиять на capture.

## 10. OpenViking coexistence

OpenViking работает независимо как `contextEngine`. Graphiti plugin не вызывает OpenViking API и наоборот.

Обе системы могут одновременно inject context в модель. Защита от raw feedback loop реализуется взаимной sanitization:

- Graphiti plugin удаляет Graphiti/OpenViking wrappers перед capture;
- OpenViking plugin удаляет `<graphiti-context>` перед своим capture.

OpenClaw core для этого не патчится.

## 11. In-memory boundary

До MCP acceptance следующие данные пока находятся только в памяти процесса OpenClaw:

- active buffers;
- transcript-delta snapshots;
- unsent/retained plugin FIFO queue entries.

Persisted Saga continuity после restart восстанавливается через `get_saga`, но pre-MCP data crash-durable storage пока не имеет.

Это известное ограничение, а не случайный баг.

# 12. СЛЕДУЮЩИЙ ЭТАП: стабилизация cross-session recall

Это ближайшая активная задача. Capture architecture до обнаружения конкретного дефекта **не переписывать**.

## 12.1 Цель этапа

Доказать и довести до production состояния следующую цепочку:

```text
fact captured in session A of agent main
          ↓
persisted in Falkor graph main
          ↓
search_memory_facts(group_ids="main")
          ↓
before_prompt_build in session B of agent main
          ↓
<graphiti-context> injected
          ↓
model can use the fact
```

Одновременно доказать negative isolation:

```text
fact in graph main
      X
must not appear for agent igor / graph igor
```

## 12.2 Текущий recall implementation

Plugin уже имеет базовый recall pipeline:

1. hook `before_prompt_build`;
2. `ctx.agentId` проходит `requireAgentId`;
3. `event.prompt` sanitizes через `prepareRecallQuery`;
4. query ограничивается `recallQueryMaxChars`;
5. вызывается `GraphitiMcpClient.searchFacts(query, agentId, recallLimit)`;
6. MCP tool = `search_memory_facts`;
7. `group_ids` передаётся как scalar `agentId`; backend Graphiti штатно принимает string и преобразует его в one-element list;
8. возвращённые `fact.fact` превращаются в bounded `<graphiti-context>`;
9. hook возвращает `{ prependContext: block }`;
10. при ошибке recall fail-open: prompt продолжает работать без Graphiti context.

Критически важно: Saga в search не передаётся **намеренно**. Recall должен быть общим между sessions одного agent.

Текущие config defaults/поля:

```text
recallLimit = 6
recallQueryMaxChars = 2000
recallMaxInjectedChars = 4000
requestTimeoutMs = 45000
```

## 12.3 Порядок диагностики. Не перескакивать этапы

### Шаг A. Подготовить два уникальных test facts

Создать легко проверяемые факты, которых гарантированно не было в памяти ранее. Лучше использовать естественные предложения и уникальные имена/свойства, а не бессмысленные random token, чтобы Graphiti extraction и semantic search работали в реалистичном режиме.

Пример класса теста:

```text
В session A агента main:
"Барбос любит только фисташковое мороженое и не ест шоколадное."
```

Для cross-agent negative test в `igor` использовать другой уникальный факт.

После capture дождаться завершения backend processing. `add_memory queued` недостаточно. Проверить `get_queue_status(group_id)` и/или фактический Falkor graph.

### Шаг B. Сначала доказать backend search напрямую

До изменения plugin выполнить MCP `search_memory_facts` непосредственно против Graphiti:

```text
query = естественный запрос по тестовому факту
group_ids = "main"
```

Ожидание: нужный fact присутствует.

Затем тот же query с:

```text
group_ids = "igor"
```

Ожидание: факт `main` отсутствует.

Если direct search не находит факт, проблема ниже plugin level. Исследовать extraction/search/rerank/Falkor прежде чем трогать `before_prompt_build`.

### Шаг C. Проверить plugin MCP client

Если прямой MCP search работает, проверить `GraphitiMcpClient.searchFacts` и фактический request/response shape.

При `logLevel=debug` и временном `logContent=true` использовать существующие события:

```text
recall_query
recall_payload
recall_completed
recall_failed
```

Не добавлять постоянный verbose logging без необходимости.

Ожидание:

```text
agentId="main"
group_id="main"
results > 0
injectedChars > 0
```

### Шаг D. Проверить cross-session hook

В другой session B того же agent `main` задать естественный вопрос, который требует факта из session A.

Проверить отдельно:

1. hook вообще вызвался;
2. query не был ошибочно отфильтрован как empty/reset;
3. MCP вернул нужный fact;
4. `buildRecallBlock` включил fact в block;
5. `prependContext` реально дошёл до model prompt;
6. model использовал факт.

Не считать пункт 6 доказательством пунктов 1-5: модель может угадать или помнить факт из другого слоя контекста. Для acceptance нужны логи/controlled test.

### Шаг E. Проверить strict cross-agent isolation

С agent `igor` задать максимально похожий вопрос.

Обязательные условия:

```text
ctx.agentId = igor
MCP group_ids = igor
```

Факты `main` не должны присутствовать ни в `recall_payload`, ни в injected block.

Затем симметрично проверить, что fact, созданный в `igor`, не появляется у `main`.

Это security/correctness invariant. Любая cross-agent утечка = blocking defect.

### Шаг F. Проверить raw feedback-loop protection

После успешного recall выполнить обычный capture следующего ответа и убедиться, что raw:

```text
<graphiti-context>...</graphiti-context>
```

не попал в `capture_payload`.

То же относится к OpenViking blocks.

### Шаг G. Только после локализации проблемы менять quality/tuning

Если plumbing исправен, но выдача плохая, исследовать по очереди:

1. качество исходных extracted facts;
2. формулировку recall query;
3. `recallLimit`;
4. `recallQueryMaxChars`;
5. `recallMaxInjectedChars`;
6. backend search/rerank behavior;
7. необходимость query enrichment из последних conversation messages.

Не добавлять query enrichment заранее. Сначала измерить, недостаточен ли действительно один `event.prompt`.

## 12.4 Recall error cooldown

После доказательства правильного recall добавить bounded cooldown только если реальный unhealthy endpoint создаёт повторяющиеся ошибки на каждый prompt.

Требования к возможному cooldown:

- scoped минимум по agent;
- recall failure никогда не блокирует prompt;
- успешный probe снимает failure state;
- capture никак не зависит от recall cooldown;
- никаких бесконечных backoff и permanent-disable без явного recovery path;
- failure/recovery должны быть видимы в operational logs.

Это optimization/hardening, не первый шаг диагностики.

## 12.5 Acceptance criteria recall phase

Этап считается завершённым, когда доказаны все условия:

1. fact, созданный в session A `main`, реально persisted;
2. direct `search_memory_facts(group_ids="main")` его находит;
3. другая session B `main` получает его через automatic recall;
4. session C того же `main` также может получить тот же fact;
5. `igor` не получает facts `main`;
6. `main` не получает facts `igor`;
7. raw injected Graphiti/OpenViking blocks не recapture'ятся;
8. пустой/неуспешный recall fail-open и не ломает prompt;
9. logs позволяют отличить no-results от transport failure;
10. regression tests покрывают group scoping, XML escaping/sanitization и cross-session semantics на уровне plugin;
11. после acceptance `logContent` возвращается в `false`, если подробная диагностика больше не нужна.

## 12.6 Что не делать в следующем этапе

Без отдельного решения владельца проекта не надо:

- патчить OpenClaw core;
- менять `group_id = agentId`;
- ограничивать recall текущей Saga;
- объединять физические Falkor graphs разных agents;
- менять capture JSON/buffering ради recall;
- добавлять reciprocal `NEXT_EPISODE`;
- включать destructive `forget/clear` tools;
- добавлять durable spool одновременно с recall debugging;
- менять OpenViking architecture.

Сначала добиться корректного cross-session recall поверх уже стабильного capture.
