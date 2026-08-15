# GRAPHITI OPENCLAW PLUGIN — HANDOFF

Дата: 2026-08-15
Проект: `piqnyx/graphiti-openclaw-plugin`
Назначение: максимально полный вводный документ для следующего программиста/ассистента.

**Прочитать этот файл и `TECHNICAL_SPEC.md` до любых архитектурных изменений.**

Если после чтения возникает желание «упростить» `group_id`, вернуть capture парами `user+assistant`, добавить обратный `NEXT_EPISODE`, патчить OpenClaw core или объединить Saga разных sessions, значит сначала надо перечитать разделы про инварианты. Эти решения уже были исследованы и приняты сознательно.

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
- память общая между sessions одного agent;
- жёсткая изоляция между разными agents;
- отсутствие необходимости писать пользователю «запомни это»;
- deterministic Saga chronology для каждой session;
- годы хранения при нормальной эксплуатации.

Graphiti plugin slot-less: он не должен вытеснять OpenViking из `contextEngine` и не должен занимать другой exclusive OpenClaw slot.

---

# 2. Критические архитектурные инварианты

## 2.1 Agent isolation

Главное соответствие:

```text
OpenClaw agentId == Graphiti group_id == Falkor physical graph name
```

Пример:

```text
main  -> group main  -> Falkor graph main
igor  -> group igor  -> Falkor graph igor
red   -> group red   -> Falkor graph red
orange-> group orange-> Falkor graph orange
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

Recall должен искать по `group_id=main` без Saga restriction. Поэтому факт из session A должен быть доступен session B/C того же agent.

Это не утечка, а **базовая цель проекта**.

Cross-agent утечка (`main` -> `igor`) недопустима.

## 2.3 Saga chronology

Одна OpenClaw session/dialog = одна Graphiti Saga.

Physical chronology:

```text
EP1 -[:NEXT_EPISODE]-> EP2 -[:NEXT_EPISODE]-> EP3
```

Обратное физическое ребро не создавать. Для прохода назад Cypher умеет traversing incoming edge:

```cypher
MATCH (current:Episodic)<-[:NEXT_EPISODE]-(previous:Episodic)
```

## 2.4 Capture больше не работает turn/pair моделью

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

GitHub:

```text
piqnyx/graphiti-openclaw-plugin
```

Серверный checkout:

```text
/home/openclaw/plugins/graphiti-openclaw-plugin
```

Текущая branch topology на момент handoff:

```text
main
```

Основные файлы:

```text
src/index.ts                 plugin hooks, capture/recall orchestration, status
src/buffer.ts                buffers + per-agent FIFO
src/transcript-delta.ts      full-snapshot -> new-message delta
src/episode-sequence.ts      Saga batch numbering / caller UUID reservation
src/mcp-client.ts            Streamable HTTP MCP client
src/text.ts                  sanitization + recall block
src/config.ts                config parsing/defaults
src/capture-constants.ts     timeout/ticker constants
openclaw.plugin.json         OpenClaw schema/manifest
TECHNICAL_SPEC.md            authoritative architecture + current next phase
TESTING.md                   test policy/invariants
TODO.md                      wishlist only
HANDOFF.md                   this document
```

Исторические `BUFFER_SPEC.md` и `json-format.md` удаляются после переноса полезных деталей в `TECHNICAL_SPEC.md`/HANDOFF. Не восстанавливать их как отдельные authoritative docs.

## 3.2 Graphiti fork

GitHub:

```text
piqnyx/graphiti
```

Серверный source checkout:

```text
/home/openclaw/memory/graphiti/source
```

Deployment root:

```text
/home/openclaw/memory/graphiti
```

Graphiti MCP container:

```text
graphiti-server
```

MCP endpoint:

```text
http://127.0.0.1:8000/mcp/
```

Health endpoint:

```text
http://127.0.0.1:8000/health
```

Secrets env location:

```text
/home/openclaw/memory/secrets/graphiti/graphiti.env
```

**Не печатать содержимое secrets и не переносить реальные ключи в Git/docs/chat.**

Текущий `main` включает fork-патчи и read-only validator. Последний значимый merge для validator:

```text
f95ed2570de87708ae906ef3e378c6126ca7a540
```

На момент handoff remote branches Graphiti:

```text
main
piqnyx/falkor-validator                 # уже merged, safe-to-delete
5x dependabot/pip/mcp_server/...        # НЕ мержить и НЕ удалять автоматически; отдельно решить
```

Dependabot — GitHub bot для dependency update PR, не человек.

## 3.3 OpenViking OpenClaw plugin

GitHub:

```text
piqnyx/openviking-openclaw-plugin
```

Серверный checkout:

```text
/home/openclaw/plugins/openviking-openclaw
```

Branch topology на момент handoff:

```text
main
```

PR #33 уже merged. В `main` есть reciprocal protection: OpenViking strip'ит `<graphiti-context>` из capture input.

Merge commit этой работы:

```text
9decb50c1adb31708fb7474cd76008b1bdd87c91
```

OpenViking считается отдельным стабильным слоем. Не менять его архитектуру ради Graphiti recall без отдельной причины.

---

# 4. OpenClaw на сервере

Установленная версия, на которой проверялась plugin API совместимость:

```text
OpenClaw 2026.8.1 (2ce4200)
```

Binary:

```text
/home/openclaw/.local/bin/openclaw
```

Global npm root:

```text
/usr/lib/node_modules
```

Основной config:

```text
/home/openclaw/.openclaw/openclaw.json
```

## Очень важное ограничение

**OpenClaw core не патчить.**

Пользователь держит OpenClaw pinned/custom и считает его базовым стабильным компонентом. Любые plugin requirements сначала реализовывать через официальные plugin seams установленной версии.

В 2026.8.1 подтверждены plugin API seams, используемые errors-only status:

```text
api.session.state.registerSessionExtension(...)
api.session.controls.registerControlUiDescriptor(...)
api.runtime.agent.session.patchSessionEntry(...)
```

Graphiti plugin публикует plugin-owned session status при capture/backend errors. Этот status не должен попадать в transcript/model context.

UI/status path best-effort: ошибка UI-state механизма не имеет права ломать capture.

---

# 5. Текущая runtime config Graphiti plugin

Последняя рабочая конфигурация пользователя по смыслу:

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
    "recallLimit": 6,
    "recallQueryMaxChars": 2000,
    "recallMaxInjectedChars": 4000,
    "logOperations": true,
    "logLevel": "debug",
    "logContent": true
  }
}
```

`logContent=true` сейчас используется для диагностики. После завершения live acceptance его желательно вернуть в `false`.

Не перезаписывать весь OpenClaw config без необходимости. Менять только нужные plugin keys.

---

# 6. Capture implementation — фактическое состояние

## 6.1 OpenClaw hook

Capture hook:

```text
agent_end
```

OpenClaw передаёт full `messagesSnapshot`, не только новое сообщение.

## 6.2 TranscriptDeltaTracker

Ключ:

```text
agentId + sessionKey
```

Tracker получает sanitized sequence `user|assistant` и вычисляет только новый suffix/overlap относительно прошлого snapshot.

Причина: если на каждом `agent_end` захватывать весь snapshot, старая история будет записываться снова и снова.

Message IDs контрактом hook не гарантированы, поэтому delta не основана на выдуманном stable id.

При первом наблюдении существующей session plugin не replay'ит всю старую историю; используется conservative current-tail behavior.

## 6.3 STOP/aborted run

`event.success=false` не означает discard.

Если пользователь написал message и остановил зависший agent, новая user message должна попасть в delta и buffer.

Этот сценарий уже покрыт unit/runtime tests и частично проверялся live.

## 6.4 BufferEngine

Один active buffer на session, FIFO одна на agent.

`addMessage`/`addMessages` принимают individual messages.

Удалены старые compatibility helpers:

```text
addTurn
extractCompletedTurn
```

Их не возвращать.

`QueueEntry.reason` фиксируется при detach:

```text
limit | timeout
```

и не reconstruct'ится при retry.

## 6.5 Timeout

Operational ticker:

```text
30 sec
```

Current live test timeout:

```text
300 sec
```

Timeout независим между sessions. Если session A лежит idle, активность session B не должна сбрасывать timeout A.

Любой non-empty buffer eligible, даже один user message.

---

# 7. Graphiti episode contract

Plugin вызывает `add_memory` с:

```text
uuid                         caller-reserved episode UUID
name                         <session-tail>-<batchNumber>
episode_body                 JSON participants + messages[]
group_id                     agentId
source                       json
source_description            OpenClaw conversation batch
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

Если transport outcome ambiguous/retry:

- тот же queue head;
- тот же UUID;
- тот же batch number;
- тот же predecessor;
- тот же reference time;
- тот же content.

Graphiti fork patch поддерживает caller UUID и `get_by_uuid` idempotent path.

Не генерировать новый UUID на retry.

---

# 9. Graphiti fork patches, которые нельзя потерять при update upstream

Fork не является vanilla Graphiti. При любом rebase/upstream update надо отдельно доказать сохранение этих свойств.

## 9.1 Request-scoped Falkor physical isolation

Graphiti request с `group_id=main` должен реально работать через Falkor graph/database `main`, а не только logical property filter внутри общего graph.

То же для `igor`, `red`, `orange`.

## 9.2 MCP UUID response/caller UUID

`add_memory` принимает caller UUID и возвращает episode UUID так, чтобы plugin мог детерминированно вести Saga sequence и retry.

## 9.3 Reliable per-group queue

Backend queue:

- FIFO per group;
- group failure не блокирует другие groups;
- retry failed episode до advance;
- terminal failure переводит group в blocked state;
- status хранит attempts/error/pending и episode metadata.

## 9.4 `get_saga`

Read-only MCP tool для restart recovery:

```text
get_saga(saga_name, group_id)
```

Возвращает persisted:

```text
uuid
name
group_id
created_at
summary
first_episode_uuid
last_episode_uuid
episode_count
```

## 9.5 `get_queue_status`

Read-only MCP tool для asynchronous persistence monitoring:

```text
get_queue_status(group_id)
```

Используется Graphiti plugin каждые 30 секунд.

## 9.6 Falkor validator

Repo tool:

```text
tools/falkor_validate.py
```

Проверяет:

- Saga first/last UUID;
- HAS_EPISODE membership;
- directed NEXT_EPISODE chain;
- N-1 chronology edges;
- predecessor/successor degrees;
- cycles;
- cross-Saga edges;
- group consistency;
- episode entity/fact counts;
- optional semantic expectations.

Zero entities = WARN по умолчанию, не structural FAIL.

---

# 10. Что уже доказано live

На реальном server/Falkor:

- несколько Saga одного `main` существуют параллельно;
- Saga isolation по session корректна;
- обе Saga живут в physical graph/group `main`;
- timeout одной session срабатывал, пока пользователь работал в другой session;
- restart hydration через `get_saga` реально восстановил `episodeCount` и `lastEpisodeUuid`;
- новый batch продолжил numbering/predecessor после restart;
- sequence `U U U U U A` был принят как `messages=6 reason=limit`;
- Graphiti backend реально обработал эти episodes;
- validator дал `failures=0 warnings=0` на двух реальных Saga;
- реальные chains были вида:

```text
1768370df35d-1 -> -2 -> -3 -> -4
2803dc63dac0-1 -> -2 -> -3 -> -4
```

- episodes имели extracted entities/facts;
- Browser confusion с одной Saga оказался `LIMIT 100` result-row issue, а не потерей Saga.

Что ещё **не считается полностью live-proven**:

- errors-only Control UI визуально при специально вызванной ошибке;
- terminal backend blocked notification в реальном failure injection;
- полный cross-session automatic recall acceptance;
- strict cross-agent recall negative test после текущих изменений;
- crash durability pre-MCP (вообще пока не реализована).

---

# 11. Failure behavior

## 11.1 До MCP acceptance

Любая ошибка capture transport/MCP/get_saga/response validation:

```text
retain FIFO head
retry later
same UUID
no sequence advance
publish errors-only session status
```

## 11.2 После acceptance

`queued` не считается persistence proof.

Plugin polling `get_queue_status(group_id)` ловит backend terminal blocked state.

Если queue backend blocked, errors-only session status должен сообщить об этом.

Если health endpoint/status call itself недоступен, status сообщает, что persistence cannot be verified.

Capture error state не должен тихо исчезать из-за менее информативной health error.

---

# 12. Recall — текущее состояние

Код уже существует, но **следующий активный этап = его стабилизация и acceptance**.

Hook:

```text
before_prompt_build
```

Pipeline:

```text
event.prompt
  -> prepareRecallQuery
  -> search_memory_facts(query, group_ids=agentId, max_facts=recallLimit)
  -> fact.fact[]
  -> buildRecallBlock
  -> <graphiti-context>...</graphiti-context>
  -> prependContext
```

`search_memory_facts` backend штатно принимает scalar string `group_ids` и coerce'ит в list.

Saga filter намеренно не используется. Это обеспечивает cross-session memory одного agent.

Errors fail-open: recall не должен ломать prompt.

**Подробный план следующего этапа находится в разделе 12 `TECHNICAL_SPEC.md`. Следующий программист должен начать именно с него.**

Первое действие после чтения docs: не менять код. Сначала direct MCP search должен доказать, что нужный fact находится в `group main` и отсутствует в `group igor`. Только потом локализовать plugin hook/injection.

---

# 13. OpenViking coexistence

OpenViking:

- отдельный contextEngine;
- уже настроен и стабилен;
- Graphiti plugin его не видит напрямую;
- модель видит injected context обоих engines.

Graphiti capture sanitization удаляет:

```text
<graphiti-context>
<openviking-context>
<relevant-memories>
```

OpenViking main после PR #33 удаляет `<graphiti-context>` перед capture.

Это defense-in-depth против raw memory feedback loop.

Не обещать невозможное: если модель своими словами перескажет recalled fact в обычном assistant response, semantic recapture теоретически возможен. Инвариант только про raw injected wrapper blocks.

---

# 14. Server operations

Пользователь предпочитает live работу **по одной команде за раз**, затем присылает output. Не вываливать 15 speculative shell steps сразу.

Не использовать в live инструкциях:

```text
set -e
set -u
```

Не выводить secrets.

## 14.1 Обновить Graphiti plugin

```bash
cd /home/openclaw/plugins/graphiti-openclaw-plugin
git pull --ff-only
npm ci
npm run verify
```

Затем при необходимости:

```bash
openclaw gateway restart
```

## 14.2 Обновить OpenViking plugin

```bash
cd /home/openclaw/plugins/openviking-openclaw
git pull --ff-only
npm ci
npm run verify
```

## 14.3 Обновить Graphiti backend после backend-code changes

Source:

```bash
cd /home/openclaw/memory/graphiti/source
git switch main
git pull --ff-only
```

Build/deploy выполняется из:

```text
/home/openclaw/memory/graphiti
```

Обычно:

```bash
docker compose build graphiti-server
docker compose up -d graphiti-server
docker compose ps
```

Не rebuild backend ради изменения только TypeScript plugin.

---

# 15. Логи

`openclaw logs --flow` неудобен при gateway restart, потому что stream рвётся.

Предпочтительный источник:

```text
/tmp/openclaw/*.log
```

Актуальный файл:

```bash
ls -1t /tmp/openclaw/*.log | head -1
```

Узкие Graphiti события, полезные для диагностики:

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
```

С `logContent=true` raw capture/recall content доступен только в debug-content events. После диагностики рекомендуется `false`.

---

# 16. Запуск Falkor validator на production окружении

Системный host Python может не иметь package `falkordb`. Это уже произошло:

```text
ModuleNotFoundError: No module named 'falkordb'
```

Не надо ради этого ставить packages globally.

Передать script в `graphiti-server`, где dependency уже есть:

```bash
cd /home/openclaw/memory/graphiti/source
docker exec -i graphiti-server python - --group main --non-interactive < tools/falkor_validate.py
```

Validator read-only.

Последний live result по `main`:

```text
sagas=2
failures=0
warnings=0
```

---

# 17. Falkor Browser / Cypher

Общий просмотр связанных paths лучше делать так:

```cypher
MATCH p=()-[]->()
RETURN p
LIMIT 5000
```

Старый запрос:

```cypher
MATCH (n) OPTIONAL MATCH (n)-[e]-(m) RETURN * LIMIT 100
```

может визуально скрывать часть graph, потому что `LIMIT` ограничивает result rows, а не число уникальных nodes.

Saga chronology view:

```cypher
MATCH p=(s:Saga)-[:HAS_EPISODE]->(e:Episodic)
OPTIONAL MATCH q=(e)-[:NEXT_EPISODE]->(next:Episodic)
RETURN p, q
LIMIT 2000
```

---

# 18. Testing philosophy

CI обязателен, но green CI не заменяет live acceptance.

Plugin стандартная проверка:

```bash
npm run verify
```

Tests должны закреплять текущие инварианты, а не исторические пары/turn model.

Regression cases capture минимум:

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

Recall acceptance описан детально в `TECHNICAL_SPEC.md`.

---

# 19. Git workflow и ветки

Пользователь разрешает прямую работу через подключенный GitHub и предпочитает маленькие понятные commits.

Для `graphiti-openclaw-plugin` сейчас branch только `main`.

Для Graphiti `main` защищён: изменения могут требовать PR. Ранее для маленьких fork additions использовалась схема:

1. temporary feature branch;
2. focused tests;
3. если штатные CI зависают на недоступном Depot runner, временный `ubuntu-latest` validation workflow **только в branch**;
4. добиться green;
5. удалить temporary workflow **до merge**;
6. squash merge;
7. удалить merged branch.

Не оставлять временные CI workflows в `main`.

На момент handoff `piqnyx/falkor-validator` уже merged и safe-to-delete, но remote branch ещё существует.

Dependabot branches не трогать автоматически.

---

# 20. Значимые Graphiti fork milestones

Полезно знать, что уже происходило:

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

Не все SHA нужны в коде, но они помогают искать историю решений.

---

# 21. Что не делать без отдельного обсуждения

- Не патчить OpenClaw core.
- Не ломать/заменять OpenViking.
- Не менять agent isolation model.
- Не делать recall session/Saga-scoped.
- Не возвращать turn/pair capture.
- Не требовать even `bufferLimit`.
- Не выбрасывать user-only buffers.
- Не считать `add_memory queued` доказательством persistence.
- Не генерировать новый UUID на retry.
- Не добавлять reciprocal `NEXT_EPISODE`.
- Не включать destructive Graphiti tools до отдельного isolation design.
- Не печатать secrets.
- Не переписывать весь `openclaw.json`, когда нужна одна настройка.

---

# 22. Известные будущие хотелки

См. `TODO.md`. Там намеренно только deferred wishlist:

- durable pre-MCP spool;
- backlog/request bounds;
- safe shutdown;
- recall cooldown/hardening после текущей фазы;
- agent-visible `graphiti_*` tools;
- operator helper/CLI;
- возможная более богатая extraction schema;
- retention/archival policy при реальном росте graph.

---

# 23. С чего следующему программисту начать прямо сейчас

Порядок:

1. Прочитать `TECHNICAL_SPEC.md` полностью.
2. Прочитать `src/index.ts`, особенно `before_prompt_build` и `agent_end`.
3. Прочитать `src/mcp-client.ts`, методы `searchFacts`, `addMemory`, `getSaga`, `getQueueStatus`.
4. В Graphiti fork прочитать MCP `search_memory_facts` и убедиться, что scalar `group_ids` штатно поддерживается.
5. Не менять код.
6. Создать/выбрать уникальный fact, реально persisted в session A agent `main`.
7. Direct MCP search: доказать, что fact находится при `group_ids=main`.
8. Direct negative search: доказать, что тот же fact отсутствует при `group_ids=igor`.
9. Только после этого проверить plugin `recall_query -> recall_payload -> prependContext` в другой session `main`.
10. Если failure найден, исправлять **тот слой, где он доказан**, добавить regression test и прогнать live acceptance.

Если direct search уже не работает, не тратить время на OpenClaw hook. Если direct search работает, не тратить время на Graphiti extraction. Локализовать проблему по слоям.

После успешного recall phase выполнить cross-agent negative acceptance и вернуть `logContent=false`.

---

# 24. Короткая mental model

Если всё остальное забыто, держать в голове это:

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
current prompt
 -> Graphiti search group=agentId
 -> facts from ALL sessions/Sagas of that agent
 -> <graphiti-context>
 -> model

ISOLATION
same agent, different sessions = shared memory GOOD
different agents = shared memory FORBIDDEN
```

Это и есть основной контракт проекта.
