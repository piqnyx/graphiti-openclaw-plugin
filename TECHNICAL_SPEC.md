# Graphiti OpenClaw Plugin — Technical Specification

Status: **authoritative implementation plan for the next version**.

Date: 2026-08-13.

Repository: `piqnyx/graphiti-openclaw-plugin`.

This file is the source of truth for the next implementation pass. Read it completely before changing code. Older handoffs, donor plugins, chat summaries, experiments, and `docs/V0.2.0_CAPTURE_PLAN.md` are non-authoritative when they conflict with this document. Some earlier notes contain intermediate ideas that were explicitly rejected during design discussion.

The next version is intentionally a substantial capture rewrite rather than another tiny proof-of-concept patch. The objective is to start long-term Graphiti memory collection with a capture format, buffering model, metadata/provenance model, and Graphiti request shape that we will not regret after months or years of data collection.

Implementation must proceed in **small coherent commits directly on `main`**, with meaningful tests added beside each behavioral change. Do not replace approved design decisions with a “cleaner” alternative without discussion.

---

## 1. What this plugin is

`graphiti-openclaw-plugin` is a **slot-less OpenClaw companion plugin** that connects ordinary OpenClaw conversations to an already-running Graphiti MCP server backed by FalkorDB.

Target runtime topology:

```text
OpenClaw
├── OpenViking                        existing contextEngine; do not disturb
├── other existing OpenClaw slots     unrelated to this plugin
└── graphiti-openclaw-plugin           companion hooks only
        │
        └── MCP Streamable HTTP
             http://127.0.0.1:8000/mcp/
                  │
                  └── existing piqnyx/graphiti
                         │
                         └── FalkorDB
```

The plugin has two logically independent automatic flows:

```text
OpenClaw conversation -> capture -> Graphiti
Graphiti -> recall -> OpenClaw prompt context
```

The next version is focused primarily on **capture/addition**: message extraction, buffer semantics, queueing, participant identity, provenance, and using the Graphiti `add_memory` surface correctly and richly.

Recall redesign is intentionally deferred except for tiny adjacent fixes explicitly listed later.

### Hard boundaries

The plugin MUST NOT:

- register as `kind: memory`;
- register as `kind: context-engine`;
- claim an exclusive OpenClaw slot;
- start, stop, supervise, patch, or reconfigure Graphiti/FalkorDB;
- write directly to Redis/FalkorDB;
- bypass the Graphiti MCP/API contract;
- modify OpenClaw core;
- modify `openclaw.json` automatically;
- patch OpenViking as an incidental side effect;
- make unrelated server/repository changes without discussion.

If another subsystem appears to require modification, stop and discuss first.

---

## 2. Identity and isolation

The authoritative Graphiti memory isolation boundary remains the OpenClaw agent:

```text
ctx.agentId -> Graphiti group_id
```

This invariant is non-negotiable.

Rules:

- `group_id` always comes from validated runtime `ctx.agentId`;
- the model never supplies `group_id`;
- session/chat/channel identity never replaces `agentId` as the Graphiti group;
- different agents must never share Graphiti groups, capture state, pending queues, or participant configuration accidentally;
- there is no hardcoded agent routing map in code;
- participant-name configuration keyed by `agentId` is metadata only, not the isolation mechanism;
- missing/invalid `ctx.agentId` fails closed for Graphiti operations.

One OpenClaw agent represents one persistent memory personality even when it is used from multiple sessions/channels.

Example:

```text
agent main
├── web session A
├── web session B
├── Telegram session C
└── future sessions/channels

all use Graphiti group_id = "main"
```

Another agent, for example `igor`, uses `group_id = "igor"` and must not see `main` data.

The existing Graphiti/FalkorDB isolation work remains a backend contract. This plugin relies on it but does not patch the backend.

---

## 3. What v0.1 already implemented and proved

The existing v0.1 code on `main` is not throwaway. It established the first real vertical path and several safety invariants.

Implemented before this specification:

- slot-less hook-only plugin manifest/build;
- OpenClaw 2026.8.1 compatibility work against core commit `2ce420091e136da4c83e65071c6caea68f3b1ac1`;
- `agent_end` capture hook;
- `before_prompt_build` recall hook;
- strict `ctx.agentId -> group_id` routing;
- in-memory capture buffering;
- shared idle scheduler;
- same-agent serialization and retained failed batch behavior;
- Graphiti Streamable HTTP MCP client;
- `add_memory` calls;
- `search_memory_facts` calls;
- Graphiti/OpenViking injected-wrapper stripping;
- OpenClaw logger integration with `error|warn|info|debug` and optional content diagnostics;
- timers that do not unnecessarily keep Node alive;
- behavioral tests for routing, isolation, sanitization, buffering, failures, MCP behavior, and recall injection.

### 3.1 Live test that already worked

The first real-server proof used:

```text
captureBatchTurns = 1
logLevel = debug
logContent = true
```

Two complete visible user/assistant exchanges produced two independent capture sequences.

Observed live properties:

- recall search used `agentId="main"`, `group_id="main"`;
- each completed exchange produced `capture_turn`;
- each produced `capture_buffered`;
- each produced `capture_flush_start` because the threshold was `1`;
- each produced `capture_payload` containing exactly the current visible exchange rather than older history;
- each produced `capture_queue_accepted`;
- captured content did not contain injected Graphiti/OpenViking memory XML;
- background heartbeat capture was skipped;
- FalkorDB showed episodic nodes created from the captures;
- Graphiti extracted at least one entity (`Вит`) and a relationship, which means the backend did more than merely accept an HTTP request.

The fact that entities/relations appeared strongly indicates that Graphiti's LLM extraction path is running. It is **not** proof that the exact intended endpoint/model/small-model configuration is correct. Later, verify the live Graphiti LLM configuration and one extraction trace from backend configuration/logs. That is a backend validation task, not a reason to redesign capture.

### 3.2 Known v0.1 limitations

The current v0.1 MCP capture client sends only:

```text
name
episode_body
group_id
source = "text"
source_description
```

It does not yet use the richer approved fields described later.

Current v0.1 capture unit is a logical completed pair (`user + final assistant`) rather than individual persisted visible transcript messages. This can lose information when a user sends several messages before one assistant response.

Current recall calls only `search_memory_facts`. It is therefore possible for useful episodic/entity data to exist in FalkorDB while the model receives zero facts for a particular recall query. A live bicycle test demonstrated that the graph can contain data even when recall returns nothing. Recall expansion is a separate later concern.

A live heartbeat also showed that capture correctly skips the background run while recall still executes a Graphiti query for the heartbeat prompt. That background recall is unnecessary and should be fixed later with the same background-run policy, but it is not allowed to distract from the capture rewrite.

### 3.3 Authoritative repository baseline

Immediately before this specification commit, authoritative `main` was still the tested v0.1 baseline:

```text
154cd5151c96cde8a2660524f86222c21cf57a0d
```

Intermediate capture-model experiments created during design discussion did **not** land on authoritative `main`. Do not assume temporary/detached experiment files exist. Implement the next version from the real repository state plus this specification.

---

## 4. v0.2 capture unit: visible messages, not turn pairs

Replace the v0.1 abstraction:

```text
CompletedTurn {
  user
  assistant
}
```

with a visible persisted message model.

Conceptual message structure:

```text
CapturedMessage {
  role: "user" | "assistant"
  text
  createdAt
  transcriptEntryId
  parentId
  seq
  idempotencyKey
  sessionId
  sessionKey
  run/runtime provenance when available
}
```

Reasons:

- users may send several messages before an assistant responds;
- turn-pair extraction can lose intermediate user messages;
- transcript entry IDs and timestamps are valuable provenance;
- deterministic batch identity needs stable source message identities;
- `captureBatchMessages=50` must mean exactly fifty real visible messages, not fifty implicit pairs/twenty-five pairs/etc.

Automatic capture must include only ordinary visible conversation material and continue excluding:

- system/hidden prompts;
- thinking/reasoning blocks;
- tool calls;
- tool results;
- assembled model prompt context;
- Graphiti injected recall blocks;
- OpenViking injected recall blocks;
- synthetic/background harness content where normal capture is inappropriate.

Do not infer missing messages and do not invent transcript metadata.

---

## 5. Source of capture data: OpenClaw transcript runtime

Preferred v0.2 source is OpenClaw's **public plugin SDK transcript/session runtime**, not manual filesystem parsing and not only the tail of `agent_end.messages`.

Before implementing, verify the exact exports against OpenClaw 2026.8.1. Use the supported visible transcript/delta APIs (currently expected around `session-transcript-runtime`, e.g. `readSessionTranscriptVisibleMessageDelta` or the corresponding current API) rather than reading private transcript storage paths directly.

Useful persisted message data includes, when present:

```text
entryId
parentId
seq
role
createdAt
idempotencyKey
message/content
```

Useful transcript identity includes, when present:

```text
agentId
sessionId
sessionKey
memoryKey / transcriptMemoryKey
```

Supported session-store/runtime reads may also provide descriptive session metadata such as label/display name/subject. Use public APIs for this. Do not parse or patch session files just to obtain a title.

Repeated hook delivery must be idempotent. Maintain a transcript watermark/cursor per active session so the same visible persisted entry cannot be re-enqueued simply because `agent_end` fires again.

---

## 6. Session -> Graphiti Saga mapping

Approved mapping:

```text
Graphiti group_id = agentId
Graphiti saga     = sessionId
```

A Graphiti Saga represents one OpenClaw conversation/session generation.

This mapping is intentionally valuable for both graph structure and future cross-system navigation.

It should eventually be possible to move conceptually like this:

```text
Graphiti fact/entity
  -> source episode
  -> Saga/sessionId
  -> stored OpenClaw session/transcript identity
  -> original transcript
```

Rules:

- never use `sessionId` as an episode UUID;
- `sessionId` is Saga identity, not episode identity;
- all batches from the same OpenClaw session use the same Saga;
- different sessions of one agent have different Sagas but still live in the same `group_id` and may connect through common entities/facts;
- mutable conversation title is never Saga identity;
- exact original `sessionId` must also be retained verbatim in provenance.

This is a deliberate reason to keep capture batches session-pure.

---

## 7. Buffer architecture: one active buffer per session

Approved state model:

```text
Map<agentId, AgentCaptureState>

AgentCaptureState {
  activeBuffers: Map<sessionId, ActiveSessionBuffer>
  pendingBatches: FIFO<DetachedCaptureBatch>
  workerState
}
```

There may be multiple active session buffers under one agent because the same owner may switch between conversations.

**Session switching does not flush anything.**

Example:

```text
session A has 29 buffered messages
user switches to session B for two minutes
session B accumulates several messages
user returns to session A
session A continues from its existing 29 messages
```

If the user never returns to session A, its own idle deadline eventually detaches the eligible partial batch.

This gives the desired semantic relationship:

```text
one session buffer -> one session Saga
```

and prevents one Graphiti episode from mixing messages belonging to several session Sagas.

### 7.1 Do not couple capture to UI/session close events

A session may be opened and never used, temporarily abandoned, closed in UI, deleted, or simply ignored. Capture correctness must not depend on tracking those UI lifecycle events.

Do not flush merely because the user switched sessions.

Do not require `session_end` as a normal flush trigger.

Idle behavior handles normal abandoned partial buffers.

---

## 8. Batch threshold and idle settings

Approved configuration semantics:

```text
captureBatchMessages
captureBatchIdleFlushSeconds
```

Defaults:

```text
captureBatchMessages = 50
captureBatchIdleFlushSeconds = 900
```

Validation:

```text
captureBatchMessages minimum = 30
captureBatchIdleFlushSeconds minimum = 30
```

`captureBatchTurns` is removed from the accepted v0.2 schema rather than retained as an ambiguous compatibility alias.

Meaning:

- `captureBatchMessages=50` means fifty real visible user/assistant transcript messages;
- several consecutive user messages all count individually;
- threshold detachment is per session buffer;
- default idle is fifteen minutes;
- minimum configurable idle is thirty seconds.

The owner wants reasonably large episodes because one-turn Graphiti ingestion is slow/noisy and creates many small episodic nodes. The intended production default is therefore 50 messages, not 1-turn micro-ingestion.

---

## 9. Hard minimum eligibility: never create a one-message conversation episode

A session can be created without any conversation. A user can send one message and the assistant can fail/hang. Those cases must not produce a useless one-message automatic conversation episode.

Hardcoded eligibility rule:

```text
minimum total visible messages = 2
AND
at least one user message
AND
at least one assistant message
```

Examples:

```text
empty session                    -> no episode
one user message                 -> no episode
several user messages, no reply  -> no episode yet
user + assistant                 -> eligible
assistant + user + assistant     -> eligible if transcript semantics make it valid visible history
```

If an incomplete buffer reaches idle timeout, do not submit it merely because time elapsed.

Preferred behavior:

- retain the small incomplete buffer in RAM;
- mark it dormant/ineligible so the scheduler does not hammer it every idle interval;
- re-evaluate only when new persisted visible messages arrive;
- if an assistant response later makes it eligible, normal threshold/idle semantics resume.

This prevents losing a lone user message only to discover later that the assistant reply arrived after the first idle deadline.

RAM cost of a few dormant incomplete messages is intentionally accepted.

---

## 10. Idle scheduler semantics

`lastActivityAt` is tracked per active session buffer.

Implementation may use one shared scheduler instead of one long-lived timer per session, as long as semantic deadlines remain per session.

Requirements:

- default idle: `900s`;
- minimum allowed: `30s`;
- threshold detach happens immediately when message count reaches the configured threshold;
- eligible partial batch detaches after its own idle period;
- ineligible partial batch is not submitted;
- timers use `unref()` where appropriate so they do not keep Node alive by themselves.

---

## 11. Detach + per-agent FIFO queue (“sausages”)

When an eligible session buffer reaches threshold or eligible idle flush:

1. atomically detach the current messages into an immutable `DetachedCaptureBatch`;
2. immediately clear/replace the active session buffer so new messages can keep arriving;
3. append the detached batch to that agent's FIFO pending queue;
4. let an asynchronous worker consume that queue from the opposite end.

Conceptually:

```text
active session buffer
        |
        | detach
        v
     [batch]
        |
        v
per-agent pending FIFO -> worker -> Graphiti MCP

new active session buffer continues immediately
```

Requirements:

- the user conversation never waits for Graphiti extraction;
- a slow/dead Graphiti endpoint does not block future OpenClaw turns;
- an in-flight batch is immutable;
- new messages do not get appended into an already-submitting batch;
- no batch is silently dropped because an arbitrary tiny memory cap was reached;
- v0.2 backlog is intentionally RAM-based;
- disk spool/crash persistence is future work;
- queue stats are observable;
- queues/workers are isolated per agent;
- one failing agent must not block another agent's queue;
- FIFO order is preserved within one agent.

The owner explicitly prefers a large RAM backlog during outages over silent loss/rotation. Do not add a 1 MB total queue limit, “drop oldest”, “drop newest”, or similar destructive policy.

Useful queue metrics:

```text
pending batch count
pending message count
approximate UTF-8 bytes
oldest pending batch age
current retry attempt/state
```

---

## 12. Submission failure and retry behavior

The v0.1 “retry after a new turn arrives” rule is not sufficient once a real FIFO exists.

Approved v0.2 behavior:

- failed submission leaves the exact same immutable batch at the queue head;
- deterministic UUID and episode body remain unchanged across retries;
- retry uses bounded exponential/backoff behavior with sane max delay;
- no infinite tight loop;
- retries are asynchronous and fail-open for the conversation;
- later batches for the same agent do not overtake the failed head;
- another agent's independent worker may continue;
- retry timers use `unref()` where appropriate.

Exact backoff constants may be chosen during implementation and locked by tests. Do not expose knobs unless operational evidence shows configuration is useful.

Known accepted v0.2 limitation: active buffers/pending queues are RAM-only. Gateway/process restart can lose unsent capture data. Crash-safe spool is future durability work and must not be improvised into this version.

---

## 13. Graphiti `source` and `episode_body`: no two automatic modes

For normal automatic conversation capture, approved behavior is always:

```text
source = "message"
```

There is no “single-message mode” versus “batch mode”. Supporting two automatic modes would increase code/test complexity without meaningful graph benefit.

Important distinction:

```text
source = "message"     # Graphiti episode type
episode_body = "..."   # actual conversation transcript chunk
```

A single Graphiti `message` episode may contain many conversational messages. That is exactly how v0.2 batches are represented.

Example:

```text
Вит: [2026-08-13T13:10:45.692Z] первое сообщение
Краб: [2026-08-13T13:10:58.600Z] ответ
Вит: [2026-08-13T13:11:18.056Z] следующее сообщение
Краб: [2026-08-13T13:11:29.621Z] ответ
```

Properties:

- message order comes from the visible persisted transcript;
- timestamp appears after the canonical speaker prefix;
- only sanitized visible text is included;
- technical provenance is not dumped into `episode_body`;
- one automatic batch contains messages from exactly one `sessionId`.

Future explicit resource/note storage may use another tool and a different Graphiti source type such as `text`. That future feature should not complicate automatic capture now.

---

## 14. Participant identity: fixed canonical names + regex aliases

Graphiti `message` episodes identify speakers. For long-term personal memory we want stable participant roots rather than `User`/`Assistant` and rather than many nickname variants becoming separate entities.

For v0.2, participant identity is configured manually per agent.

Conceptual config:

```json
{
  "participants": {
    "main": {
      "user": {
        "canonicalName": "Вит",
        "aliasPatterns": [
          "Ви|Вит|Виктор"
        ]
      },
      "assistant": {
        "canonicalName": "Краб",
        "aliasPatterns": [
          "Краб(?:стер|ушек)?|Креветка|Криль"
        ]
      }
    }
  }
}
```

Exact property names may change slightly only for schema ergonomics; semantics are fixed.

### 14.1 Canonical output to Graphiti

Generated `episode_body` always uses the configured canonical speaker names:

```text
Вит: ...
Краб: ...
```

It must not use `Ви`, `Виктор`, `Крабстер`, `Крабушек`, `Креветка`, `Криль`, etc. as structural speaker labels merely because those names appear conversationally.

This is capture-side normalization only. The actual visible OpenClaw transcript is not rewritten.

### 14.2 Why regex aliases

Nicknames can have many variants. A regex list is more compact than enumerating every possible form.

Requirements:

- patterns are trusted owner configuration, never model-supplied;
- compile once during config/startup, not on every message;
- invalid regex fails configuration clearly;
- bound pattern count/length reasonably to avoid pathological configuration;
- use Unicode/case-aware behavior appropriately;
- do not blindly replace arbitrary matching substrings throughout the conversation body;
- canonical speaker prefixes remain fixed regardless of aliases;
- regex matching is used to recognize observed participant references and produce explicit alias-to-canonical guidance/provenance for Graphiti extraction.

The LLM should receive ordinary concrete statements such as:

```text
"Виктор" and "Ви" refer to the configured participant "Вит" in this batch.
"Крабстер" and "Криль" refer to the configured participant "Краб" in this batch.
```

Do not send regex syntax itself to the extraction LLM as if it were semantic data.

### 14.3 Why manual config first

Do not query OpenViking at runtime during v0.2 just to discover participant names.

Future automation may ask OpenViking/profile memory what the user prefers to be called and update participant configuration. That could improve onboarding/privacy and handle ownership/name changes later. It is intentionally deferred because current deployment has only a small number of known agents/users and a direct config is simpler and safer.

### 14.4 Renames later

If an assistant is renamed later, change the canonical name and keep the old name in alias patterns rather than rewriting historical Graphiti episodes.

Example:

```text
old canonical: Краб
new canonical: Алиса
old name becomes an alias for the same participant
```

The same idea applies if ownership/naming conventions change.

### 14.5 Missing participant configuration

Do not silently invent a new persistent participant name.

Preferred graph-integrity policy:

```text
autoCapture enabled + no participant config for this agent
-> clear warning
-> skip this agent's automatic Graphiti capture until configured
```

This must not affect `group_id` isolation or other agents.

---

## 15. Why central participant nodes are acceptable

It is expected that persistent participants such as `Вит` and `Краб` become high-degree nodes in a personal memory graph.

That is not automatically graph corruption. A personal graph naturally has central entities:

```text
Вит
├── projects
├── devices
├── locations
├── preferences
├── people
└── decisions
```

Likewise a project such as OpenClaw may become another large hub.

The extraction instruction must prevent assistant repetition/jokes/hallucinations from creating bogus durable facts, but it should not try to suppress useful participant connections merely to make the visualization less dense.

Aliases are used to keep one stable participant entity rather than several near-duplicate roots.

---

## 16. Approved Graphiti `add_memory` field mapping

The guiding principle is: **collect useful truthful provenance now because missing historical provenance may be impossible to reconstruct after a year**.

Populate every field for which the plugin has truthful, useful information. Do not populate fields merely because they exist.

### 16.1 Fields to populate

#### `name`

Readable episode identifier.

Recommended ingredients:

```text
agentId
short sessionId
optional session label snapshot
reference time
episode UUID prefix
```

Session title/label is optional descriptive text only. It is never identity/deduplication input because it may change.

#### `episode_body`

Full sanitized visible conversation batch for exactly one session, chronological, with canonical participant prefixes and message timestamps.

#### `group_id`

Always validated `ctx.agentId`.

#### `source`

Always `"message"` for automatic conversation capture.

#### `source_description`

Versioned machine-readable JSON provenance envelope. See section 17.

#### `uuid`

Client-generated deterministic UUID for the **specific detached batch**.

This is an intentional change from v0.1 and exists primarily for retry idempotency.

Never use `sessionId` as episode UUID.

#### `reference_time`

Timestamp of the last captured visible message when available.

Also retain first and last timestamps in provenance.

If persisted timestamps are unavailable, use the best truthful runtime fallback and record that a fallback was used instead of pretending it came from the transcript.

#### `custom_extraction_instructions`

Plugin-owned stable base instruction plus participant/observed-alias information for the batch. See section 19.

Do not expose arbitrary free-form instruction config in v0.2.

#### `saga`

Use the exact OpenClaw `sessionId` unless the live MCP strictly requires a reversible namespaced form. Preserve the exact original value verbatim in provenance regardless.

#### `update_communities`

Support this deliberately in v0.2.

Approved config key:

```text
captureUpdateCommunities
```

Target default:

```text
true
```

Reason: capture is asynchronous, the deployment has ample resources for this metadata/graph work, and the goal is to use the graph engine richly instead of omitting useful derived structure by default.

Before live deployment, confirm the running MCP `add_memory` schema accepts the field and observe the real cost. If the live server rejects it, stop and discuss; do not silently mutate the approved semantics.

### 16.2 Fields intentionally omitted by default

#### `previous_episode_uuids`

Do not send.

Graphiti can select recent previous episodes automatically when this explicit list is omitted. Passing one locally known previous UUID may reduce the server's available history rather than improve it.

Omitting this field is an intentional use of Graphiti's server-side behavior, not a forgotten feature.

The plugin may retain previous submitted UUIDs for diagnostics/queue state without sending them in this field.

#### `saga_previous_episode_uuid`

Do not send by default.

With `saga=sessionId`, let Graphiti resolve the latest actually persisted episode in the Saga. This is safer than pointing to a locally previous batch that may only have been queue-accepted and not persisted yet.

#### `excluded_entity_types`

Do not send until there is a demonstrated entity type we intentionally want Graphiti to ignore.

### 16.3 Live schema is final request-shape authority

Before production v0.2 deployment, query the **running Graphiti MCP server** with `tools/list` and inspect its exact `add_memory` schema.

The source repository/fork explains semantics, but the live server is the final authority on what the deployed endpoint accepts.

If live schema differs from this plan, stop and discuss rather than guessing.

---

## 17. Rich provenance in `source_description`

`source_description` becomes a versioned JSON envelope instead of a short prose sentence.

Purpose:

- future debugging;
- backlink from Graphiti episode to OpenClaw session/transcript;
- reconstruct where/when/how a batch was captured;
- preserve model/provider/channel provenance;
- support future tools that navigate from graph memory back to source transcript;
- preserve metadata now that may be impossible to infer later.

Never invent absent values. Omit unavailable optional fields.

Target envelope shape:

```json
{
  "schema": "openclaw.graphiti.capture-provenance/v1",
  "pluginVersion": "0.2.0",
  "openclawVersion": "2026.8.1",

  "agentId": "main",
  "sessionId": "...",
  "sessionKey": "...",
  "transcriptMemoryKey": "...",

  "sessionLabelSnapshot": "...",
  "sessionDisplayNameSnapshot": "...",
  "sessionSubjectSnapshot": "...",

  "participants": {
    "userCanonicalName": "Вит",
    "assistantCanonicalName": "Краб",
    "observedUserAliases": ["Виктор"],
    "observedAssistantAliases": ["Крабстер"]
  },

  "channel": "...",
  "messageProvider": "...",
  "accountId": "...",
  "chatId": "...",
  "channelId": "...",
  "senderId": "...",

  "runIds": ["..."],
  "triggerValues": ["user"],
  "modelProviderIds": ["..."],
  "modelIds": ["..."],

  "workspaceDir": "...",
  "activeProjectKeys": ["..."],

  "messageCount": 50,
  "firstMessageAt": "...",
  "lastMessageAt": "...",
  "firstTranscriptSeq": 100,
  "lastTranscriptSeq": 149,

  "transcriptEntryIds": ["..."],
  "parentEntryIds": ["..."],
  "idempotencyKeys": ["..."],

  "episodeUuid": "...",
  "captureFormat": "message/v1"
}
```

Useful data sources may include:

- visible transcript runtime;
- transcript/session identity runtime;
- supported session metadata reads;
- `agent_end` event data such as contributing run ID/success/duration when useful;
- hook context values such as agent/session identity, model/provider, channel/account/chat/sender/trigger/workspace/project metadata where actually available.

Do **not** store:

- API keys;
- authorization headers;
- credentials;
- secret-provider data;
- arbitrary opaque runtime objects;
- entire raw `channelContext` objects merely because they are reachable.

Select stable non-secret identifiers/scalars only.

Do not duplicate full conversation text in provenance; `episode_body` owns conversation content.

---

## 18. Deterministic episode UUID

Every detached batch receives one stable deterministic UUID.

Required properties:

- same exact detached batch retry -> same UUID;
- reordered/different entry set -> different UUID;
- same session, different batch -> different UUID;
- same entry IDs under another agent -> different UUID;
- mutable session title does not affect UUID;
- retry attempt/process-local counters do not affect UUID.

Recommended canonical identity input:

```json
{
  "schema": "openclaw.graphiti.batch-id/v1",
  "agentId": "main",
  "sessionId": "...",
  "entryIds": ["ordered", "transcript", "entry", "ids"]
}
```

Recommended algorithm:

1. canonical UTF-8 serialization;
2. SHA-256;
3. encode deterministic RFC-4122-compatible UUID shape (for example properly marked UUIDv8).

Once implemented, exact canonicalization/hash-to-UUID logic is a compatibility contract and requires regression tests.

Do not generate a random UUID for normal retryable automatic batches.

---

## 19. Custom extraction instruction

Automatic capture uses a plugin-owned, versioned base instruction.

It must communicate these semantics to Graphiti:

- episode is an OpenClaw conversation between configured persistent participants;
- canonical participant names are stable identities for this graph;
- observed nickname/alias forms identified by plugin regex config refer to the corresponding canonical participant, not separate people;
- first-person user statements refer to the configured user participant when context supports it;
- prioritize durable facts explicitly supported by the conversation: identity, preferences, ownership, relationships, locations, projects, decisions, plans, devices, stable state, and other concrete long-lived information;
- assistant messages may provide context/confirmation, but unsupported assistant assumptions must not become durable user facts;
- assistant repetition of a user statement must not create bogus independent facts such as the assistant “owning” the user's bicycle;
- jokes, roleplay, speculation, temporary filler, tool chatter, hidden/system material, and injected memory blocks should not become durable facts merely because they surrounded the conversation;
- other people/projects/objects/places should still be extracted normally rather than forcing every relation to attach only to the two primary participants.

Per batch, append concrete observed alias guidance such as:

```text
Observed participant alias "Виктор" refers to canonical participant "Вит".
Observed participant alias "Крабстер" refers to canonical participant "Краб".
```

Do not hand regex syntax to the LLM as semantic text.

Keep the instruction concise enough not to waste excessive extraction context.

---

## 20. Session titles/names

OpenClaw session titles/labels may change.

Therefore:

- do not use title as Saga identity;
- do not use title in deterministic UUID input;
- do not require title to exist;
- when a supported OpenClaw API provides label/display name/subject, store it as a provenance snapshot;
- optionally include the snapshot in Graphiti `name` for humans.

Stable cross-system identity is still:

```text
sessionId
+ sessionKey
+ transcriptMemoryKey
```

where available.

---

## 21. Sanitization remains mandatory

Before a visible message enters capture state, strip only known injected memory wrappers/metadata that must not be recursively captured.

Existing defense includes:

```text
<graphiti-context>...</graphiti-context>
<relevant-memories>...</relevant-memories>
<openviking-context ...>...</openviking-context>
```

Requirements remain:

- support attributes/case/multiline content;
- support multiple adjacent blocks;
- do not greedily eat malformed/lookalike arbitrary user XML;
- sanitize before content logging and before queueing;
- do not build a general XML rewriter.

Known cross-plugin asymmetry remains outside this repo: OpenViking currently strips its own wrappers but not Graphiti's wrapper. That separate patch can happen later and must not be silently included here.

---

## 22. Async capture semantics

Capture remains asynchronous end-to-end.

Intended flow:

```text
OpenClaw conversation
  -> transcript delta read
  -> sanitize + dedupe
  -> per-session active buffer
  -> detach immutable batch
  -> per-agent FIFO queue
  -> MCP add_memory
  -> Graphiti queue acceptance
  -> Graphiti background extraction/persistence
```

The user/model turn must not wait for Graphiti entity/fact extraction.

Logging must continue distinguishing:

```text
Graphiti queue accepted != Graphiti persistence/extraction completed
```

Do not call an accepted MCP queue request “persisted”.

---

## 23. `update_communities`

Communities are derived graph structure/clusters. For this deployment the approved direction is to use them rather than postponing them indefinitely.

v0.2 therefore supports:

```text
captureUpdateCommunities = true   # target default
```

Rationale:

- ingestion is asynchronous so user latency should not directly wait for community work;
- the graph is intended for long-lived rich memory;
- additional derived structure may become valuable for later traversal/recall;
- compute/memory conservation is not the primary constraint here.

Still measure actual backend cost during live testing and verify the live MCP accepts the field.

Do not confuse Graphiti/FalkorDB storage capacity with LLM context limits. Large RAM backlog is acceptable, but individual episode/request size must still remain compatible with the backend/model. v0.2 does not silently truncate or drop messages; measure/log batch bytes and discuss explicit splitting rules if the live backend demonstrates a real input limit.

---

## 24. v0.2 configuration target

Existing unrelated recall/logging settings remain unless separately changed.

Capture-side target:

```json
{
  "autoCapture": true,
  "captureBatchMessages": 50,
  "captureBatchIdleFlushSeconds": 900,
  "captureUpdateCommunities": true,
  "participants": {
    "main": {
      "user": {
        "canonicalName": "Вит",
        "aliasPatterns": ["Ви|Вит|Виктор"]
      },
      "assistant": {
        "canonicalName": "Краб",
        "aliasPatterns": ["Краб(?:стер|ушек)?|Креветка|Криль"]
      }
    }
  }
}
```

Validation requirements:

- `captureBatchMessages`: integer, min `30`, sensible upper bound;
- `captureBatchIdleFlushSeconds`: integer, min `30`, sensible upper bound;
- `captureUpdateCommunities`: boolean;
- `participants`: object keyed by configured OpenClaw agent IDs;
- non-empty canonical names;
- alias regex patterns must compile;
- bound regex count/length reasonably;
- reject unknown/malformed options rather than silently accepting typos.

`captureBatchTurns` must no longer be accepted by v0.2.

Production participant mappings for deployed agents are entered manually before long-term capture starts.

---

## 25. Logging/observability for v0.2

Keep current logger architecture and `logContent` safety switch.

Add/adjust stable events such as:

```text
capture_transcript_delta
capture_no_new_messages
capture_incomplete_session
capture_message_buffered
capture_batch_detached
capture_queue_state
capture_submit_start
capture_submit_accepted
capture_submit_failed
capture_retry_scheduled
capture_payload
```

Useful fields:

```text
agentId
group_id
sessionId
saga
messageCount
activeBufferMessages
pendingBatches
pendingMessages
pendingBytes
oldestPendingAgeMs
reason=threshold|idle
uuid
referenceTime
source=message
updateCommunities
request duration
retry attempt
next retry delay
retained=true on failure
```

When `logContent=false`, do not log raw conversation bodies.

When `logContent=true`, log the sanitized **final body/request metadata actually sent** so live testing can prove transformations precisely.

Do not log secrets.

---

## 26. Small adjacent fix allowed in this version

The live test showed background heartbeat capture is skipped while Graphiti recall still executes for the heartbeat prompt.

If the same existing background-run classifier can be reused safely, v0.2 may make recall symmetrical:

```text
heartbeat/background automatic run -> no Graphiti auto-recall
cron/background run                 -> no Graphiti auto-recall
subagent/background run             -> no Graphiti auto-recall
```

This must be a separate small commit/test and must not expand into a recall redesign.

---

## 27. Required tests

Tests must be behavioral/failure-oriented. Do not add decorative tests that merely assert a mock returns what it was told.

### Configuration

Cover at least:

- default `captureBatchMessages=50`;
- reject `<30`;
- default idle `900`;
- accept idle `30`;
- reject idle `<30`;
- `captureUpdateCommunities` boolean validation;
- participant config parsing;
- missing/empty canonical names;
- invalid regex patterns;
- excessive regex input if bounds are implemented;
- unknown keys fail closed;
- old `captureBatchTurns` is rejected in v0.2.

### Transcript capture/dedupe

Cover at least:

- several user messages before one assistant are all preserved;
- repeated hook/transcript delta delivery does not duplicate entries;
- transcript order is preserved by `seq`/visible projection;
- hidden/tool/thinking/injected memory content is excluded;
- Graphiti/OpenViking wrapper stripping still works;
- message metadata is retained when available and omitted when unavailable.

### Session buffer semantics

Cover at least:

- same agent can have two active session buffers;
- switching sessions does not flush either buffer;
- returning to an earlier session continues its buffer;
- empty session creates no batch;
- one user message creates no episode;
- several user messages without assistant remain ineligible;
- user+assistant becomes eligible;
- threshold 50 detaches exactly that session's 50 messages;
- idle 900 semantics;
- minimum idle 30 semantics;
- idle affects only the due session;
- ineligible idle buffer does not get repeatedly resubmitted/re-timer hammered;
- timers do not keep Node alive unnecessarily.

### FIFO/worker/retry

Cover at least:

- detached batch is immutable;
- new messages continue in fresh active buffer while prior batch submits;
- FIFO order preserved per agent;
- failed head batch remains head;
- retry keeps same UUID/body;
- later same-agent batch does not overtake failed head;
- another agent can continue while first agent fails;
- retry backoff is bounded and non-busy;
- queue stats accurately reflect pending batches/messages/bytes.

### Participant identity

Cover at least:

- canonical names always appear as speaker prefixes;
- alias regex matches configured variants/case as intended;
- invalid alias regex fails config;
- body text is not blindly regex-rewritten;
- observed aliases become explicit canonical guidance/provenance;
- missing participant config follows the approved safe policy;
- two agents can have different participant mappings without leakage.

### Episode construction

Cover at least:

- `source="message"` always for auto-capture;
- batch contains only one `sessionId`;
- `saga=sessionId`;
- `group_id=agentId`;
- message timestamps appear after speaker prefixes;
- `reference_time` uses last persisted message time;
- deterministic UUID stability/order sensitivity/agent sensitivity;
- mutable session title does not affect UUID;
- provenance includes available transcript/session IDs;
- unavailable optional provenance fields are omitted;
- no secrets are included;
- `update_communities` follows config;
- `previous_episode_uuids` omitted;
- `saga_previous_episode_uuid` omitted;
- `excluded_entity_types` omitted.

### Runtime integration

At least one runtime-level test must exercise the actual chain:

```text
OpenClaw-like hook event/context
 -> transcript delta adapter
 -> sanitization/dedupe
 -> session buffer
 -> detach
 -> FIFO worker
 -> GraphitiMcpClient.addMemory
```

and inspect the resulting tool arguments rather than testing isolated mocks only.

---

## 28. Live acceptance plan after implementation

Do not reset long-term memory merely to test half-finished code. Finish the v0.2 capture pipeline, then perform one deliberate live acceptance sequence.

Before deployment:

1. `npm ci` / typecheck / build / full tests pass;
2. inspect live MCP `tools/list` and confirm approved `add_memory` fields;
3. inspect plugin manifest/config schema;
4. set manual participant mappings for real agents;
5. enable debug content logging only temporarily.

Live proof should verify:

1. plugin loads and remains hook-only/slot-less;
2. ordinary messages accumulate without immediate micro-ingestion;
3. different sessions of same agent maintain independent active buffers;
4. a 50-message session threshold detaches one session-pure batch;
5. an eligible partial session detaches after idle;
6. one-message/incomplete session is not ingested;
7. logs show canonical participant speaker names;
8. aliases in conversation do not create alternate structural speaker labels;
9. logs show `group_id=agentId`, `saga=sessionId`, deterministic UUID, reference time, provenance, `source=message`, and community flag;
10. Graphiti accepts the richer payload;
11. FalkorDB shows episodic/Saga/entity/fact structure after background processing;
12. multiple batches of one session attach to the same Saga;
13. different sessions create different Sagas in the same agent group;
14. cross-agent isolation remains intact;
15. a temporary Graphiti failure retains FIFO batch and later retry uses the same UUID/body;
16. OpenViking remains unaffected;
17. after diagnostics, `logContent` returns to `false`.

Graphiti's internal quality of entity/fact extraction is observed but is not entirely this plugin's jurisdiction. The plugin's responsibility is to send complete, correctly typed, correctly scoped, well-provenanced capture data without loss or cross-agent leakage.

---

## 29. Implementation sequence and commit discipline

Work in short rollback-friendly commits. Suggested order:

1. **config contract**: `captureBatchMessages`, idle defaults/minimum, communities flag, participant config + regex validation, tests;
2. **transcript adapter**: supported OpenClaw public transcript/session runtime, message delta/watermark model, tests;
3. **participant resolver**: canonical names, regex alias detection, observed alias mapping, tests;
4. **capture model**: normalized message type, episode body formatting, deterministic UUID, reference time, provenance builder, extraction instruction, tests;
5. **per-session buffers**: active buffer map, minimum eligibility, threshold/idle scheduler, tests;
6. **per-agent FIFO workers**: immutable batches, queue metrics, serialization/fairness, tests;
7. **retry/backoff**: retained head batch and same UUID/body, tests;
8. **MCP request expansion**: all approved `add_memory` fields, omission rules, request-shape tests;
9. **hook integration**: replace old completed-turn capture with transcript-delta pipeline, runtime tests;
10. **logging/diagnostics**: new structured events and content-gated payload logging, tests;
11. **small background-recall symmetry fix** if still safe/relevant, separate commit/test;
12. only after behavior is complete, update package version/manifest, TODO, CHANGELOG, README/other docs to match actual implementation;
13. full repository audit and live acceptance.

At every step:

- run relevant tests;
- do not leave broken CI knowingly;
- do not combine unrelated architectural changes in one commit;
- if an approved assumption conflicts with the live OpenClaw/Graphiti contract, stop and discuss before inventing a workaround.

---

## 30. Explicitly deferred work

Not part of this capture-focused version unless separately approved:

- crash-safe disk spool/persistent queue;
- agent-visible Graphiti recall/store/forget/status tools;
- delete/forget API design;
- full recall redesign beyond the tiny background-run fix;
- raw episode retrieval in recall;
- OpenViking automatic participant-name discovery/config synchronization;
- direct resource/document ingestion tool (`add_resource`-like future feature);
- explicit manual `previous_episode_uuids` chaining;
- explicit manual `saga_previous_episode_uuid` chaining;
- backend patches;
- OpenViking reciprocal Graphiti-wrapper patch;
- destructive queue/backlog caps;
- arbitrary custom extraction prompt supplied by config/model.

---

## 31. Final approved design summary

The next version must implement this model:

```text
OpenClaw visible persisted messages
        |
        v
public transcript delta API
        |
        v
sanitize + dedupe
        |
        v
Map<agentId, AgentState>
        |
        +-- Map<sessionId, ActiveBuffer>
        |        threshold: 50 messages
        |        idle: 900s default, 30s minimum
        |        hard eligibility: >=2 messages with user+assistant
        |
        +-- per-agent FIFO pending batches
                   |
                   v
              async worker
                   |
                   v
Graphiti add_memory
  group_id                  = agentId
  saga                      = sessionId
  source                    = message
  episode_body              = canonicalName: [timestamp] text ...
  name                      = readable technical identifier
  uuid                      = deterministic batch UUID
  reference_time            = last captured message timestamp
  source_description        = rich versioned JSON provenance
  custom_extraction_instructions = stable rules + concrete observed aliases
  update_communities        = configured, target default true

  previous_episode_uuids    = omitted intentionally
  saga_previous_episode_uuid= omitted intentionally
  excluded_entity_types     = omitted until justified
```

Participant identity:

```text
per agent config
  user canonical name + regex alias patterns
  assistant canonical name + regex alias patterns

Graphiti structural speakers always use canonical names.
Observed nickname forms are mapped to canonical identities for extraction guidance/provenance.
```

The central philosophy is simple: **capture as much truthful reusable provenance as we reasonably have now, preserve session identity as Graphiti Saga, normalize participant identity, avoid micro-episodes, never block the conversation on Graphiti, never silently discard backlog, and keep agent isolation absolute.**
