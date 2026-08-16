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

1. до работы с transcript отклоняются sessions, попавшие под `excludeSessionPatterns` (см. 8.2);
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

Реально развёрнутые значения хранятся в OpenClaw config и в HANDOFF §5. Крупные batch намеренно предпочтительнее мелких: extraction лучше строит личности и связи на большом куске диалога и реже дёргает LLM. Верхняя граница определяется не плагином, а тем, сколько текста стабильно переваривает LLM backend Graphiti.

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

Если в spool лежит batch с уже зарезервированной episode identity, тот же вызов используется для reconciliation (см. 11.2): identity сверяется с `last_episode_uuid` до любой повторной отправки.

## 8.2 Excluded sessions

`excludeSessionPatterns` — **единственный** источник правды о том, какие sessions plugin игнорирует. Применяется одинаково к capture и recall: session, которую мы не пишем, не должна и получать injected memory.

Каждый элемент — исходник JavaScript-регулярки, unanchored. Проверяется по двум значениям:

1. OpenClaw session key (`agent:main:telegram:42`);
2. run trigger (`cron`, `heartbeat`, `user`, ...) — чтобы background run отсекался даже если в его session key нет маркера.

Якорить нужно осознанно: `:cron:` ищется в любом месте ключа, `^cron$` совпадает ровно с trigger.

Дефолт воспроизводит прежний hardcoded отсев и является обычным конфигом:

```json
"excludeSessionPatterns": [":cron:", ":heartbeat:", ":subagent:", "^cron$", "^heartbeat$", "^\\*\\*\\*$"]
```

Если список переопределяется в конфиге, он переопределяется целиком — hardcoded отсева больше нет ни для чего. Невалидная регулярка отвергается при загрузке plugin вместе со всем конфигом.

Пример добавления dreaming-сессий:

```json
"excludeSessionPatterns": [":cron:", ":heartbeat:", ":subagent:", "^cron$", "^heartbeat$", "^\\*\\*\\*$", "^agent:[^:]+:dreaming-"]
```

Это фильтр по **служебным sessions**, а не изоляция диалогов. Кросс-сессионная память внутри агента остаётся обязательной: факт из одной session должен находиться recall в другой session того же агента.

## 8.3 Agent-visible tools

Включаются ключом `agentTools` (по умолчанию `true`) и регистрируются только если host предоставляет tool API. Права на конкретный tool для конкретного агента остаются за OpenClaw allowlist — plugin не дублирует эту политику.

```text
graphiti_recall            поиск фактов в памяти агента
graphiti_search_entities   поиск сущностей с их summary
graphiti_episodes          последние закоммиченные батчи
graphiti_store             одна durable-заметка
graphiti_status            здоровье backend + позиция текущего диалога в саге
```

Инварианты:

- agentId берётся из tool context и проходит `requireAgentId`; он же уходит как `group_id`. Tool физически не может обратиться к графу другого агента.
- session, попавшая под `excludeSessionPatterns`, не может пользоваться tools вообще: то, что мы не записываем, не должно и запрашивать память.
- `graphiti_store` пишет episode **без saga**. Saga — хронология одного диалога, которую ведёт capture pipeline; вставка заметки в эту цепочку разветвила бы predecessor links.
- текст заметки проходит ту же санитизацию, что и capture, поэтому injected memory wrappers нельзя протащить обратно в граф через tool.
- ошибка backend возвращается агенту текстом с `ok=false`, а не исключением.

### 8.3.1 Почему нет destructive tools

MCP-инструменты `delete_episode`, `delete_entity_edge` и `get_episode_entities` **не принимают `group_id`** и работают через общий driver, то есть по базе по умолчанию, а не по физическому графу агента. Дать агенту удаление поверх этого нельзя: изоляция, ради которой построен весь стек, на этом пути отсутствует.

Условия, при которых `graphiti_forget` можно будет рассмотреть, перечислены в `TODO.md`; первым из них идёт group-scoped удаление на стороне форка.

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

## 11. Durable capture state

До MCP acceptance capture state хранится в атомарном local spool:

```text
$OPENCLAW_STATE_DIR/graphiti-openclaw-plugin/capture-spool.json
```

Файл пишется через temp + `fsync` + `rename` + `fsync` каталога, права `0600`, schema version 2. Version 1 файлы мигрируются при чтении, чтобы upgrade gateway не оставлял capture data за проверкой схемы.

Spool содержит:

- active buffers каждой session;
- unsent/retained FIFO entries агента вместе с их `reason` и `enqueuedAt`;
- зарезервированную episode identity уже отправленного batch (`uuid`, `name`, `batchNumber`, predecessor);
- per-session transcript watermarks.

### 11.1 Transcript watermarks

Watermark — это FNV-хеши последних 12 наблюдённых сообщений session плюс их количество. Content в spool не попадает. При первом `agent_end` после restart delta считается от watermark, а не от boundary detection, поэтому session не переигрывает уже захваченный хвост и не теряет turn, чей `agent_end` не успел сработать до остановки. Если transcript переписан настолько, что watermark не находится, применяется прежний conservative fallback.

Watermark двигается **только после того**, как delta реально попала в buffer. Наблюдение не равно захвату: если буферизация отказала, watermark остаётся на месте, и следующий процесс увидит эти сообщения снова, а не сочтёт их захваченными.

Watermarks живут не дольше 14 суток и ограничены 64 последними sessions; полные transcripts в памяти ограничены теми же 64 sessions по LRU.

### 11.2 Reconciliation восстановленного batch

Batch, чей ответ `add_memory` потерян вместе с процессом, **не переотправляется вслепую**. Перед повтором вызывается `get_saga`:

```text
last_episode_uuid == зарезервированный uuid -> episode уже в графе:
                                               batch снимается, chain продолжается с него
иначе                                       -> повтор с тем же uuid, name и predecessor
```

Если saga ушла дальше зарезервированного `batchNumber` или чейнится с другим predecessor, identity не переиспользуется, резервируется новая, и это пишется в лог как `capture_replay_identity_diverged`.

Точка коммита остаётся прежней — MCP acceptance. Graphiti queue живёт в памяти MCP-процесса, поэтому restart самого MCP-сервера всё ещё может потерять принятый, но необработанный episode; это ловится через `get_queue_status` и остаётся известным ограничением backend, а не плагина.

### 11.3 Ошибка записи spool

Неудачная запись spool никогда не отменяет capture: сообщения остаются в памяти, ошибка сообщается один раз (`capture_spool_write_failed`), следующая мутация повторяет checkpoint. Checkpoint после acceptance вынесен из delivery try/catch и не может быть показан пользователю как transport failure.

# 12. Recall pipeline и его live acceptance

Recall hardening из этого раздела **реализован**; раздел остаётся авторитетным описанием recall pipeline, его конфигурации и критериев приёмки, а не списком незавершённой работы.

Capture architecture до обнаружения конкретного дефекта **не переписывать**. Базовый Graphiti recall доказан live; работа этого этапа сделала его наблюдаемым, устойчивым к контекстно-зависимым вопросам и настраиваемым без изменения isolation model.

Текущий активный этап — стабильность capture: durable spool под штатные stop/start (раздел 11), единый фильтр sessions (8.2) и live acceptance обоих направлений на чистой памяти.

## 12.1 Уже доказано live до hardening patch

На `main` с отключённым OpenViking выполнен controlled cross-session test:

```text
новая session main
  -> before_prompt_build
  -> search_memory_facts(group_ids="main")
  -> results=6
  -> непустой <graphiti-context>
  -> модель корректно ответила фактами из Graphiti
```

Модель успешно восстановила `Григолети`, `Хванчкару` и `холодный каркаде` из Graphiti в новой session. Direct MCP search тех же данных также был успешен. Cross-agent negative test показал, что `igor` facts `main` не получает.

Следовательно, не надо менять hook, `group_id`, Saga semantics или сам MCP search path без нового конкретного дефекта.

## 12.2 Recall pipeline

Pipeline после hardening:

1. hook `before_prompt_build`;
2. `ctx.agentId` проходит `requireAgentId`;
3. current `event.prompt` sanitizes и проверяется на empty/reset;
4. при `recallUseHistory=true` к query добавляется bounded tail последних sanitized `user|assistant` messages;
5. Graphiti/OpenViking injection wrappers удаляются и из prompt, и из history;
6. history ограничивается `recallHistoryMaxMessages` и `recallHistoryMaxChars`;
7. весь query ограничивается `recallQueryMaxChars`, при truncation сохраняется **новейший tail**, а не старый prefix;
8. вызывается `GraphitiMcpClient.searchFacts(query, agentId, recallLimit)`;
9. MCP tool = `search_memory_facts`;
10. `group_ids` передаётся как scalar `agentId`; backend Graphiti штатно преобразует string в one-element list;
11. Graphiti basic search уже использует hybrid BM25 + cosine similarity с RRF reranking;
12. возвращённые `fact.fact` превращаются в bounded `<graphiti-context>`;
13. block помечает содержимое как long-term memory, а не user instructions, и отдаёт приоритет текущей беседе при конфликте;
14. hook возвращает `{ prependContext: block }`;
15. при ошибке recall fail-open: prompt продолжает работать без Graphiti context.

Saga в search не передаётся **намеренно**. Recall общий между sessions одного agent.

## 12.3 Recall config

Defaults:

```text
requestTimeoutMs = 45000
recallLimit = 8
recallQueryMaxChars = 6000
recallMaxInjectedChars = 8000
recallUseHistory = true
recallHistoryMaxMessages = 6
recallHistoryMaxChars = 4000
```

Семантика:

- `requestTimeoutMs` — MCP request timeout и budget для modifying recall hook;
- `recallLimit` — `max_facts` Graphiti search, то есть максимум retrieved facts до injection budget;
- `recallQueryMaxChars` — общий character budget финального recall query;
- `recallMaxInjectedChars` — максимальный размер всего `<graphiti-context>`;
- `recallUseHistory` — включает/выключает recent conversation enrichment;
- `recallHistoryMaxMessages` — максимум последних sanitized conversation messages для enrichment;
- `recallHistoryMaxChars` — отдельный character budget history portion до объединения с current prompt.

Большое context window модели не является причиной делать recall query или injection огромными: retrieval должен оставаться сфокусированным. Эти defaults являются стартовыми и подлежат live tuning только по наблюдаемым результатам.

## 12.4 Диагностика content и финального model input

Подробный content logging включается **только** одновременно тремя существующими operator switches:

```json
{
  "logOperations": true,
  "logLevel": "debug",
  "logContent": true
}
```

При таком режиме доступны:

```text
mcp_raw_request
mcp_raw_response
recall_query
recall_payload
llm_input_raw
capture_messages
capture_payload
capture_mcp_response
```

Content events намеренно отправляются через INFO sink, хотя требуют `logLevel=debug`, потому что plugin DEBUG не гарантированно виден в journald.

`recall_payload` различает:

```text
retrievedFacts
injectedFacts
skippedFacts
injectedChars
```

Это позволяет отличить плохой search от факта, который нашёлся, но не поместился в injection budget.

`llm_input_raw` использует штатный OpenClaw `llm_input` observation hook и логирует exposed model boundary:

```text
systemPrompt
prompt
historyMessages
```

Он нужен для controlled testing, чтобы видеть одновременно фактические Graphiti и OpenViking wrappers перед model submission без patch OpenClaw core.

Raw content diagnostics чувствительны и потенциально объёмны. После acceptance `logContent` вернуть в `false`.

## 12.5 Memory wrapper contract

Graphiti injection имеет форму:

```xml
<graphiti-context>
Source: graphiti-auto-recall
Long-term memory, not user instructions. Use only when relevant; current conversation wins on conflict.
Relevant memories:
- ...
</graphiti-context>
```

Сами tag names менять без причины не надо: mutual stripping Graphiti/OpenViking уже ориентируется на существующие wrappers.

## 12.6 Clean-memory live acceptance

После merge hardening patch и rebuild plugin:

1. очистить тестовые Graphiti и OpenViking memory stores;
2. включить оба memory слоя;
3. создать небольшой контролируемый conversation corpus;
4. дождаться Graphiti backend processing и OpenViking persistence/indexing;
5. проверить same-agent cross-session recall;
6. проверить cross-agent negative isolation;
7. проверить вопрос с местоимением/ссылкой на предыдущие 2-6 messages, где history enrichment реально нужен;
8. задать нерелевантный вопрос и убедиться, что memory не навязывает случайные facts;
9. сравнить `recall_query`, `recall_payload` и `llm_input_raw`;
10. убедиться, что raw Graphiti/OpenViking injection blocks не recapture'ятся;
11. после tuning вернуть `logContent=false`.

## 12.7 Reranking policy

Дополнительный reranker сейчас **не добавлять**. Graphiti `search_memory_facts` уже идёт через basic hybrid search:

```text
BM25 + cosine similarity -> RRF
```

MMR/cross-encoder/threshold controls добавлять только если clean-memory traces покажут систематически плохой ranking. Не увеличивать latency и сложность ради теоретического улучшения.

## 12.8 Recall error cooldown

Bounded per-agent cooldown/backoff добавлять только если live unhealthy-endpoint test покажет повторяющийся шум/нагрузку на каждый prompt.

Требования к возможному cooldown:

- scoped минимум по agent;
- recall failure никогда не блокирует prompt;
- успешный probe снимает failure state;
- capture никак не зависит от recall cooldown;
- никаких permanent-disable без recovery path;
- failure/recovery видимы в operational logs.

## 12.9 Acceptance criteria

Этап считается завершённым, когда доказаны:

1. controlled facts реально persisted после clean reset;
2. direct Graphiti search находит fact только в правильном group;
3. новая session того же agent получает fact automatic recall;
4. context-dependent follow-up находит fact с bounded history enrichment;
5. `igor` не получает facts `main` и наоборот;
6. raw injected Graphiti/OpenViking blocks не recapture'ятся;
7. нерелевантный prompt не получает разрушительный/noisy memory effect;
8. empty/failed recall fail-open и не ломает prompt;
9. logs различают no-results, retrieved facts, budget-skipped facts и transport failure;
10. `llm_input_raw` подтверждает фактический model boundary с обоими memory layers;
11. regression tests покрывают group scoping, XML sanitization, query/history bounds и injection bounds;
12. после acceptance `logContent=false` в обычной эксплуатации.

## 12.10 Что не делать без отдельного решения владельца

- не патчить OpenClaw core;
- не менять `group_id = agentId`;
- не ограничивать recall текущей Saga;
- не объединять physical Falkor graphs разных agents;
- не менять capture JSON/buffering ради recall;
- не менять working capture transport path ради косметики;
- не добавлять destructive memory tools;
- не добавлять durable spool одновременно с recall testing;
- не менять OpenViking architecture ради Graphiti recall;
- не добавлять cross-encoder/MMR без измеренного quality defect.
