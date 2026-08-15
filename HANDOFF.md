# GRAPHITI OPENCLAW PLUGIN — HANDOFF

Дата: 2026-08-15
Проект: `piqnyx/graphiti-openclaw-plugin`
Назначение: полный вводный документ для следующего программиста/ассистента.

**Прочитать этот файл и `TECHNICAL_SPEC.md` до любых архитектурных изменений.**

Если возникает желание «упростить» `group_id`, вернуть capture парами `user+assistant`, добавить обратный `NEXT_EPISODE`, патчить OpenClaw core или объединить Saga разных sessions, сначала перечитать разделы про инварианты. Эти решения уже исследованы и приняты сознательно.

---

# 1. Что это за система

Строится двухслойная память OpenClaw:

```text
OpenClaw model
   ├─ OpenViking contextEngine
   │    └─ contextual/archive/active memory
   │
   └─ Graphiti companion plugin
        └─ temporal knowledge graph in FalkorDB
```

OpenViking и Graphiti **не вызывают друг друга**. Они независимо inject context в модель. Модель может видеть оба слоя.

Цель Graphiti-слоя:

- автоматический capture conversation messages;
- долговременный temporal knowledge graph;
- автоматический recall;
- общая память между sessions одного agent;
- жёсткая изоляция между agents;
- отсутствие необходимости писать «запомни это»;
- deterministic Saga chronology для каждой session;
- годы хранения при нормальной эксплуатации.

Graphiti plugin slot-less: он не должен вытеснять OpenViking из `contextEngine` и не должен занимать другой exclusive OpenClaw slot.

---

# 2. Критические архитектурные инварианты

## 2.1 Agent isolation

```text
OpenClaw agentId == Graphiti group_id == Falkor physical graph name
```

Пример:

```text
main   -> group main   -> Falkor graph main
igor   -> group igor   -> Falkor graph igor
red    -> group red    -> Falkor graph red
orange -> group orange -> Falkor graph orange
```

**Никогда не использовать model name, user name, Telegram chat id или session id как group_id.**

## 2.2 Sessions одного agent имеют общую память

Каждая OpenClaw session получает отдельную Saga, но все Saga одного agent живут в одном `group_id`/physical graph.

```text
agent main
  ├─ saga session-A
  ├─ saga session-B
  └─ saga session-C
```

Recall ищет по `group_id=main` без Saga restriction. Факт из session A должен быть доступен session B/C того же agent.

Это не утечка, а **базовая цель проекта**.

Cross-agent утечка (`main` -> `igor`) недопустима.

## 2.3 Saga chronology

Одна OpenClaw session/dialog = одна Graphiti Saga.

```text
EP1 -[:NEXT_EPISODE]-> EP2 -[:NEXT_EPISODE]-> EP3
```

Обратное физическое ребро не создавать. Для прохода назад Cypher traverses incoming edge.

## 2.4 Capture не работает turn/pair моделью

Atomic unit = отдельное sanitized conversation message.

Нормальны:

```text
U A
U U U A
U U U
A A
одинокий U
```

`bufferLimit=6` означает **6 сообщений**, а не 3 пары.

---

# 3. Репозитории

## 3.1 Основной plugin

```text
GitHub: piqnyx/graphiti-openclaw-plugin
server: /home/openclaw/plugins/graphiti-openclaw-plugin
```

Основные файлы:

```text
src/index.ts                 hooks, capture/recall orchestration, status, llm_input diagnostics
src/buffer.ts                buffers + per-agent FIFO
src/transcript-delta.ts      full-snapshot -> new-message delta
src/episode-sequence.ts      Saga numbering / caller UUID reservation
src/mcp-client.ts            Streamable HTTP MCP client
src/text.ts                  sanitization + recall query/block construction
src/config.ts                config parsing/defaults
src/logging.ts               structured + opt-in content diagnostics
src/capture-constants.ts     timeout/ticker constants
openclaw.plugin.json         OpenClaw schema/manifest
TECHNICAL_SPEC.md            authoritative architecture/current phase
TESTING.md                   test policy/invariants
TODO.md                      deferred wishlist only
HANDOFF.md                   this document
```

Исторические `BUFFER_SPEC.md` и `json-format.md` удалены после консолидации. Не восстанавливать их как competing authoritative docs.

## 3.2 Graphiti fork

```text
GitHub: piqnyx/graphiti
source: /home/openclaw/memory/graphiti/source
deployment: /home/openclaw/memory/graphiti
container: graphiti-server
MCP: http://127.0.0.1:8000/mcp/
health: http://127.0.0.1:8000/health
```

Secrets:

```text
/home/openclaw/memory/secrets/graphiti/graphiti.env
```

**Не печатать secrets и не переносить реальные ключи в Git/docs/chat.**

Fork содержит request-scoped Falkor isolation, reliable queue, caller UUID, Saga support, queue status и validator. При upstream update эти свойства надо доказать заново.

## 3.3 OpenViking OpenClaw plugin

```text
GitHub: piqnyx/openviking-openclaw-plugin
server: /home/openclaw/plugins/openviking-openclaw
```

В `main` есть reciprocal protection: OpenViking sanitization удаляет:

```text
<openviking-context>...</openviking-context>
<relevant-memories>...</relevant-memories>
<graphiti-context>...</graphiti-context>
```

Graphiti делает зеркальное stripping. OpenViking считается отдельным стабильным слоем. Не менять его архитектуру ради Graphiti recall без отдельной причины.

---

# 4. OpenClaw на сервере

Проверенная версия:

```text
OpenClaw 2026.8.1 (2ce4200)
```

```text
binary: /home/openclaw/.local/bin/openclaw
global npm root: /usr/lib/node_modules
config: /home/openclaw/.openclaw/openclaw.json
```

## Очень важное ограничение

**OpenClaw core не патчить.**

Подтверждены нужные official plugin seams:

```text
before_prompt_build -> prependContext
llm_input           -> observation of assembled model boundary
api.session.state.registerSessionExtension(...)
api.session.controls.registerControlUiDescriptor(...)
api.runtime.agent.session.patchSessionEntry(...)
```

`llm_input` в pinned OpenClaw получает exposed `systemPrompt`, `prompt`, `historyMessages`, provider/model immediately before submission path. Это используется только для opt-in diagnostics и не модифицирует model input.

UI/status path best-effort: ошибка UI-state механизма не имеет права ломать capture.

---

# 5. Рекомендуемая runtime config Graphiti plugin

После recall hardening стартовый test config:

```json
{
  "enabled": true,
  "hooks": {
    "allowPromptInjection": true,
    "allowConversationAccess": true
  },
  "config": {
    "baseUrl": "http://127.0.0.1:8000/mcp/",
    "autoCapture": true,
    "autoRecall": true,
    "bufferLimit": 6,
    "bufferTimeout": 300,
    "agents": {
      "main":   { "user": "Вит",     "assistant": "Краб" },
      "igor":   { "user": "Игорь",   "assistant": "Краб" },
      "red":    { "user": "Человек", "assistant": "Бот" },
      "orange": { "user": "Человек", "assistant": "Бот" }
    },
    "requestTimeoutMs": 45000,
    "recallLimit": 8,
    "recallQueryMaxChars": 6000,
    "recallMaxInjectedChars": 8000,
    "recallUseHistory": true,
    "recallHistoryMaxMessages": 6,
    "recallHistoryMaxChars": 4000,
    "logOperations": true,
    "logLevel": "debug",
    "logContent": true
  }
}
```

Если в `openclaw.json` явно остались старые `6/2000/4000`, defaults их не заменят: для controlled tests нужно явно поставить значения выше.

Три logging switches имеют совместную семантику:

```text
logOperations=true
logLevel=debug
logContent=true
```

Только при всех трёх доступны raw content diagnostics, включая final `llm_input_raw`. После live acceptance `logContent` вернуть в `false`.

Не перезаписывать весь OpenClaw config. Менять только нужные plugin keys.

---

# 6. Capture implementation — фактическое состояние

## 6.1 OpenClaw hook

```text
agent_end
```

OpenClaw передаёт full `messagesSnapshot`, не только новое сообщение.

## 6.2 TranscriptDeltaTracker

Ключ:

```text
agentId + sessionKey
```

Tracker получает sanitized sequence `user|assistant` и вычисляет только новый suffix/overlap относительно прошлого snapshot. Message IDs контрактом hook не гарантированы, поэтому delta не основана на выдуманном stable id.

При первом наблюдении существующей session plugin не replay'ит всю старую историю; используется conservative current-tail behavior.

## 6.3 STOP/aborted run

`event.success=false` не означает discard. Новая user message должна попасть в delta и buffer даже при aborted/failed run.

## 6.4 BufferEngine

Один active buffer на session, FIFO одна на agent.

Удалены старые compatibility helpers:

```text
addTurn
extractCompletedTurn
```

Их не возвращать.

`QueueEntry.reason` фиксируется при detach как `limit | timeout` и не reconstruct'ится при retry.

## 6.5 Timeout

Operational ticker = 30 sec. Current live test timeout = 300 sec.

Timeout независим между sessions. Любой non-empty buffer eligible, даже один user message.

**Capture semantics считаются стабильными. Recall work не является поводом переписывать этот pipeline.**

---

# 7. Graphiti episode contract

Plugin вызывает `add_memory` с:

```text
uuid                         caller-reserved episode UUID
name                         <session-tail>-<batchNumber>
episode_body                 JSON participants + messages[]
group_id                     agentId
source                       json
source_description           OpenClaw conversation batch
saga                         sessionKey
reference_time               QueueEntry.enqueuedAt ISO-8601
previous_episode_uuids       [] или [last episode UUID]
saga_previous_episode_uuid   отсутствует или last episode UUID
custom_extraction_instructions internal plugin prompt
```

Custom extraction prompt нужен из-за nested `messages[].text`.

---

# 8. Caller UUID и transport ambiguity

Caller UUID резервируется **до MCP request**.

При ambiguous transport/retry сохраняются:

- тот же queue head;
- тот же UUID;
- тот же batch number;
- тот же predecessor;
- тот же reference time;
- тот же content.

Не генерировать новый UUID на retry.

---

# 9. Graphiti fork patches, которые нельзя потерять

Fork не vanilla Graphiti. При любом rebase/upstream update отдельно доказать:

1. request-scoped Falkor physical isolation;
2. caller-visible episode UUID / idempotent caller UUID path;
3. reliable per-group FIFO queue с retry/block state;
4. `get_saga(saga_name, group_id)`;
5. `get_queue_status(group_id)`;
6. directed Saga chronology;
7. `tools/falkor_validate.py` read-only validator.

---

# 10. Что уже доказано live

Capture/Falkor:

- несколько Saga одного `main` существуют параллельно;
- Saga isolation по session корректна;
- Saga одного agent живут в physical graph/group `main`;
- timeout одной session срабатывает при активности другой;
- restart hydration через `get_saga` восстановил `episodeCount` и `lastEpisodeUuid`;
- новый batch продолжил numbering/predecessor после restart;
- arbitrary role sequence работал;
- backend обработал episodes;
- validator дал `failures=0 warnings=0`;
- episodes имели extracted entities/facts.

Recall baseline, доказано 2026-08-15 до hardening patch:

- direct MCP `search_memory_facts(group_ids="main")` вернул реальные facts;
- fresh session агента `main` с отключённым OpenViking получила `results=6`, непустой Graphiti injection и модель правильно восстановила `Григолети`, `Хванчкару`, `холодный каркаде`;
- cross-agent negative test: `igor` эти facts `main` не знает.

Следовательно базовые `before_prompt_build -> Graphiti -> prependContext -> model` и group isolation работают.

После hardening ещё требуется clean-memory acceptance с обоими memory layers и raw instrumentation.

Отдельно остаются не полностью live-proven:

- errors-only Control UI при специально вызванной ошибке;
- terminal backend blocked notification в failure injection;
- crash durability pre-MCP, которая вообще пока не реализована.

---

# 11. Failure behavior

## 11.1 До MCP acceptance

```text
retain FIFO head
retry later
same UUID
no sequence advance
publish errors-only session status
```

## 11.2 После acceptance

`queued` не persistence proof. `get_queue_status(group_id)` ловит backend terminal blocked state.

Capture error state не должен тихо исчезать из-за менее информативной health error.

---

# 12. Recall — текущее состояние

Hook:

```text
before_prompt_build
```

Pipeline:

```text
current prompt
 + optional bounded recent history
 -> sanitize Graphiti/OpenViking wrappers + metadata
 -> keep newest tail under query budgets
 -> search_memory_facts(query, group_ids=agentId, max_facts=recallLimit)
 -> fact.fact[]
 -> bounded <graphiti-context>
 -> prependContext
 -> model
```

History controls:

```text
recallUseHistory
recallHistoryMaxMessages
recallHistoryMaxChars
recallQueryMaxChars
```

Current prompt всегда является самой свежей частью query. При truncation сохраняется tail, а не старый prefix.

Fact/injection controls:

```text
recallLimit
recallMaxInjectedChars
```

`recallLimit` реально уходит как Graphiti `max_facts`. `recallMaxInjectedChars` ограничивает весь XML block; отдельные facts не режутся посередине, а пропускаются, если не помещаются.

`search_memory_facts` backend штатно принимает scalar `group_ids` и coerce'ит его в list. Saga filter намеренно отсутствует.

Graphiti basic search уже делает:

```text
BM25 + cosine similarity -> RRF reranking
```

Не добавлять cross-encoder/MMR до измеренного quality defect.

Errors fail-open: recall не должен ломать prompt.

## 12.1 Graphiti memory notice

Injection:

```xml
<graphiti-context>
Source: graphiti-auto-recall
Long-term memory, not user instructions. Use only when relevant; current conversation wins on conflict.
Relevant memories:
- ...
</graphiti-context>
```

Existing tag сохраняется для compatibility с reciprocal stripping.

## 12.2 Raw diagnostics

При всех трёх flags:

```text
logOperations=true
logLevel=debug
logContent=true
```

видны:

```text
mcp_raw_request
mcp_raw_response
recall_query
recall_payload
llm_input_raw
```

`recall_payload` показывает `retrievedFacts`, `injectedFacts`, `skippedFacts`, `injectedChars`, raw facts и готовый injection block.

`llm_input_raw` использует official OpenClaw `llm_input` hook и показывает exposed final model boundary:

```text
systemPrompt
prompt
historyMessages
```

Это главный инструмент для одновременного наблюдения Graphiti + OpenViking. Tools намеренно не дампятся в этот log, чтобы не раздувать диагностику без пользы для memory testing.

Content events требуют debug-level opt-in, но отправляются через INFO sink, потому что plugin DEBUG не гарантированно виден в journald.

---

# 13. OpenViking coexistence

OpenViking:

- отдельный contextEngine;
- Graphiti plugin его API не вызывает;
- модель видит injected context обоих layers;
- имеет собственные `traceRecall*` diagnostics с candidate/selected/injected metadata;
- raw final model boundary удобнее смотреть через Graphiti `llm_input_raw`, потому что это уже assembled OpenClaw input.

Graphiti sanitization удаляет:

```text
<graphiti-context>
<openviking-context>
<relevant-memories>
```

OpenViking sanitization также удаляет все три wrappers. Это defense-in-depth против raw memory feedback loop.

Если модель своими словами перескажет recalled fact в обычном assistant response, semantic recapture теоретически возможен. Инвариант только про raw injected wrappers.

---

# 14. Server operations

Пользователь предпочитает live работу по коротким проверяемым шагам. Не вываливать 15 speculative shell commands одновременно. Не использовать `set -e`/`set -u`. Не выводить secrets.

## 14.1 Обновить Graphiti plugin

```bash
cd /home/openclaw/plugins/graphiti-openclaw-plugin
git pull --ff-only origin main
npm ci --ignore-scripts
npm run verify
```

`npm run verify` делает typecheck, rebuild `dist/` и tests. После этого:

```bash
systemctl --user restart openclaw-gateway.service
```

Backend Graphiti rebuild для TypeScript plugin change не нужен.

## 14.2 Обновить OpenViking plugin

```bash
cd /home/openclaw/plugins/openviking-openclaw
git pull --ff-only origin main
npm ci --ignore-scripts
npm run verify
```

## 14.3 Обновить Graphiti backend после backend-code changes

```bash
cd /home/openclaw/memory/graphiti/source
git switch main
git pull --ff-only origin main
```

Build/deploy из `/home/openclaw/memory/graphiti`:

```bash
docker compose build graphiti-server
docker compose up -d graphiti-server
docker compose ps
```

---

# 15. Логи

Для systemd service удобно:

```bash
journalctl --user -u openclaw-gateway.service --since "5 min ago" --no-pager
```

Recall/diagnostic filter:

```bash
journalctl --user -u openclaw-gateway.service --since "5 min ago" --no-pager \
  | grep -E 'graphiti: event=(recall_query|recall_payload|recall_completed|recall_failed|llm_input_raw|mcp_raw_request|mcp_raw_response)'
```

Полезные operational events:

```text
plugin_loaded
capture_messages
capture_sequence_hydrated
capture_flush_start
capture_queue_accepted
capture_flush_failed
capture_flush_recovered
capture_backend_*
recall_query
recall_payload
recall_completed
recall_failed
llm_input_raw
mcp_raw_request
mcp_raw_response
```

Raw strings JSON-escaped, поэтому XML/newlines в journald идут одной строкой с `\n`.

После controlled testing `logContent=false`.

---

# 16. Falkor validator

Host Python может не иметь `falkordb`. Не ставить package global ради validator.

```bash
cd /home/openclaw/memory/graphiti/source
docker exec -i graphiti-server python - --group main --non-interactive < tools/falkor_validate.py
```

Validator read-only.

---

# 17. Falkor Browser / Cypher

Общий просмотр:

```cypher
MATCH p=()-[]->()
RETURN p
LIMIT 5000
```

Saga chronology:

```cypher
MATCH p=(s:Saga)-[:HAS_EPISODE]->(e:Episodic)
OPTIONAL MATCH q=(e)-[:NEXT_EPISODE]->(next:Episodic)
RETURN p, q
LIMIT 2000
```

`LIMIT` ограничивает result rows, а не число уникальных nodes, поэтому слишком низкий LIMIT может визуально скрыть часть graph.

---

# 18. Testing philosophy

CI обязателен, но green CI не заменяет live acceptance.

```bash
npm run verify
```

Capture regression cases минимум:

```text
U A
U U U A
U A U U U A
7xU + A при limit=6
single U timeout
U on aborted run
successive full snapshots without duplicate replay
snapshot rewrite/overlap fallback
```

Recall regression tests должны закреплять:

- group scoping;
- scalar `group_ids` contract;
- `max_facts` propagation;
- XML stripping/escaping;
- history max messages/chars;
- total query max chars с tail preservation;
- current prompt retention;
- injection max chars;
- retrieved/injected/skipped accounting;
- opt-in `llm_input_raw` registration/content.

Live acceptance подробно описан в `TECHNICAL_SPEC.md` section 12.

---

# 19. Git workflow

Для текущего recall hardening используется focused branch/PR, CI на `ubuntu-latest`, затем merge только после green и diff review. Capture semantics менять в этом PR запрещено.

Основное правило: маленький понятный commit/PR, regression tests, green CI, затем live acceptance.

Не оставлять временные workflows/branches после завершения работы.

---

# 20. Значимые Graphiti fork milestones

```text
f364f009... request-scoped FalkorDB graph isolation
066aeb55... MCP graph scoping + structured output retry
dabc65fb... bounded per-group queue + startup-race fix
05b1ef71... queue tests
44ab6f16... MCP import path
4d76fca9... fork docs
6ac7bd9f... caller-visible queued episode UUIDs
4cb6dcc2... retry failed episodes before queue advance
2aa8f5d6... Saga hydration fix
7a0c62f8... get_saga merged
4f533997... get_queue_status / terminal queue-state support
f95ed257... read-only Falkor Saga validator
```

---

# 21. Что не делать без отдельного обсуждения

- Не патчить OpenClaw core.
- Не ломать/заменять OpenViking.
- Не менять agent isolation model.
- Не делать recall session/Saga-scoped.
- Не возвращать turn/pair capture.
- Не менять стабильный capture pipeline ради recall.
- Не требовать even `bufferLimit`.
- Не выбрасывать user-only buffers.
- Не считать `add_memory queued` persistence proof.
- Не генерировать новый UUID на retry.
- Не добавлять reciprocal `NEXT_EPISODE`.
- Не включать destructive Graphiti tools до отдельного isolation design.
- Не добавлять cross-encoder/MMR без измеренного retrieval defect.
- Не печатать secrets.
- Не переписывать весь `openclaw.json`, когда нужна одна настройка.

---

# 22. Известные будущие хотелки

См. `TODO.md`:

- durable pre-MCP spool;
- backlog/request bounds;
- safe shutdown;
- recall cooldown только если live failure докажет необходимость;
- richer quality/rerank controls только по traces;
- agent-visible `graphiti_*` tools;
- operator helper/CLI;
- richer extraction schema при доказанной необходимости;
- retention/archival policy при реальном росте graph.

---

# 23. Текущий live-план после merge recall hardening

1. На сервере pull `main`, `npm run verify`, restart gateway.
2. Обновить только Graphiti plugin config recall keys до рекомендуемых test values.
3. Очистить тестовые Graphiti и OpenViking memory stores штатными existing reset scripts.
4. Включить оба layers.
5. Создать небольшой естественный controlled corpus, достаточный для Graphiti buffer flush и OpenViking persistence.
6. Дождаться фактической обработки/indexing, а не только queue acceptance.
7. Новая session `main`: same-agent cross-session recall.
8. Context-dependent follow-up с местоимениями: проверить пользу recent-history query.
9. Agent `igor`: strict negative isolation.
10. Нерелевантный вопрос: проверить noise resistance.
11. Сопоставить `recall_query`, `recall_payload`, `llm_input_raw` и реальный ответ модели.
12. Проверить, что `capture_payload` после recall не содержит raw Graphiti/OpenViking wrappers.
13. После tuning вернуть `logContent=false`.

Не дропать/перестраивать backend containers ради plugin-only test, если existing reset scripts уже очищают данные штатно.

---

# 24. Короткая mental model

```text
CAPTURE
OpenClaw full transcript snapshot
 -> per-session delta
 -> individual messages
 -> per-session buffer
 -> per-agent FIFO
 -> deterministic Saga UUID chain
 -> Graphiti group=agentId
 -> physical Falkor graph=agentId

RECALL
current prompt + bounded recent history
 -> sanitize both memory systems' wrappers
 -> focused tail-bounded query
 -> Graphiti hybrid search group=agentId
 -> retrieved facts
 -> bounded <graphiti-context>
 -> prependContext
 -> final llm_input observation
 -> model

ISOLATION
same agent, different sessions = shared memory GOOD
different agents = shared memory FORBIDDEN

OBSERVABILITY
recall_query = what we searched
recall_payload = what Graphiti returned and what block was built
llm_input_raw = what OpenClaw exposed at final model boundary
```

Это основной контракт проекта на текущем этапе.
