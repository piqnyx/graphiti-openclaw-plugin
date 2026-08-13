# Graphiti OpenClaw Plugin — Initial Technical Specification

Status: active specification for the first live vertical slice.

This file is the authority for v0.1. Older handoffs, donor plugins, experiments, and previous design notes are non-authoritative when they conflict with this document.

## Implementation status — 2026-08-13

The code-side v0.1 vertical slice is implemented on `main` and is validated by npm CI (`typecheck + build + tests`). The OpenClaw 2026.8.1 hook contract was checked against core commit `2ce420091e136da4c83e65071c6caea68f3b1ac1` before binding runtime hooks.

Implemented:

- slot-less plugin manifest and npm/TypeScript build;
- `agent_end` completed-turn extraction;
- strict `ctx.agentId -> group_id` identity;
- one in-memory capture buffer per agent, shared across all conversations of that agent;
- one shared idle scheduler that monitors all per-agent buffers;
- completed-turn threshold flush and five-minute idle flush;
- failed flush retention without autonomous retry loops;
- same-agent flush serialization, including turns arriving while a request is in flight;
- Graphiti Streamable HTTP MCP client for `add_memory` and `search_memory_facts`;
- automatic bounded `<graphiti-context>` recall injection;
- Graphiti/OpenViking wrapper stripping before Graphiti capture/query processing;
- leveled OpenClaw logging with optional live-debug content logging;
- behavioral tests covering routing, isolation, batching, failure retention, concurrent arrivals, sanitization, MCP request shape, and recall injection.

Still pending: the real-server acceptance sequence in section 12. Until that passes, v0.1 is code-complete but not live-accepted.

## 1. Goal

Build the smallest production-shaped OpenClaw companion plugin that proves the complete path:

1. OpenClaw completed turns are auto-captured.
2. Captured turns reach the existing Graphiti MCP server.
3. Graphiti persists them into the existing FalkorDB graph and builds entities/facts/relationships.
4. Relevant Graphiti memory is automatically recalled before a model turn.
5. Recall works in the same conversation and across different conversations of the same agent.
6. Different OpenClaw agents remain strictly isolated.
7. OpenViking continues operating independently.

v0.1 is intentionally small. Agent-visible Graphiti tools are not part of the first live test.

## 2. Existing architecture and hard boundaries

The plugin is a slot-less companion plugin.

```text
OpenClaw
├── OpenViking                  existing contextEngine
├── existing memory component   existing memory slot, if configured
└── graphiti-openclaw-plugin     companion hooks only
        │
        └── MCP -> http://127.0.0.1:8000/mcp/
                    │
                    └── existing piqnyx/graphiti -> FalkorDB
```

The plugin MUST NOT:

- register as `kind: memory`;
- register as `kind: context-engine`;
- claim an exclusive OpenClaw slot;
- start, stop, supervise, patch, reconfigure, or embed Graphiti/FalkorDB;
- modify OpenClaw core;
- modify `openclaw.json` itself;
- bypass Graphiti through direct Redis/FalkorDB queries.

Changes to OpenViking are a separate reviewed change and release, never an implicit side effect of this plugin.

Any need to change another subsystem is a stop-and-discuss event before making the change.

## 3. Identity and isolation

The authoritative Graphiti identity is:

```text
OpenClaw ctx.agentId -> Graphiti group_id
```

Rules:

- `group_id` is never supplied by the model;
- `group_id` is never derived from conversation/session identity;
- no hardcoded list of agent IDs exists in the plugin;
- missing/invalid `ctx.agentId` fails closed for capture/recall;
- every Graphiti operation performed for an agent uses that agent's resolved `group_id`.

The existing `piqnyx/graphiti` fork contains FalkorDB group-isolation fixes, including request-scoped driver handling for concurrent `group_id` operations. The plugin relies on that backend contract but does not patch it.

## 4. Agent is the memory personality boundary

A single OpenClaw agent represents one persistent person/identity even when that agent is used from many conversations or channels.

```text
agent main
├── web conversation A
├── web conversation B
├── web conversation C
└── Telegram

all share Graphiti group_id = main
```

Another agent has a different graph and MUST NOT see `main` memory.

Capture state is process-wide for the plugin and keyed by **agentId only**:

```text
Map<agentId, AgentCaptureBuffer>
```

`session_end` MUST NOT flush the buffer merely because one conversation ended. Cross-conversation batching is intentional.

## 5. Completed turn definition

One capture unit is one completed logical turn:

```text
USER
+
final ASSISTANT response after that user message
```

The threshold is measured in completed turns, not individual messages.

For v0.1 the extractor is conservative:

- take the trailing user message from `agent_end` conversation messages;
- take the final assistant response after that user message;
- do not resend older turns;
- do not intentionally persist thinking blocks, tool calls, tool results, assembled prompts, or injected memory blocks;
- skip incomplete runs without both halves of a completed turn;
- exclude known synthetic/background harness turns when they can be identified safely.

## 6. Auto-capture buffer

Configuration:

```text
captureBatchTurns
captureBatchIdleFlushSeconds
```

Defaults:

```text
captureBatchTurns = 10
captureBatchIdleFlushSeconds = 300
```

`captureBatchTurns = 1` is explicitly supported and is the preferred first live-debug setting. Each completed turn then becomes immediately eligible for one Graphiti episode.

The plugin owns one shared scheduler for idle flushing. It does **not** allocate one long-lived timer per conversation or one independent timer object per agent. Agent buffers keep their own last-activity timestamps; the shared scheduler wakes for the earliest due buffer and then reevaluates all buffers.

Behavior:

```text
agent_end
  -> extract completed turn
  -> append to buffer[agentId]
  -> update that buffer's last activity time
  -> shared scheduler recalculates the next idle deadline

if buffer[agentId].turns >= captureBatchTurns
  -> flush that agent's currently buffered turns

if buffer[agentId] has waited >= captureBatchIdleFlushSeconds
  -> shared scheduler flushes that agent's partial batch
```

Requirements:

- agent buffers never mix;
- concurrent flushes for the same agent must not duplicate/interleave a batch;
- turns arriving during a flush remain safe for the next batch;
- no session boundary changes agent-buffer semantics;
- failure must never silently discard a batch.

### v0.1 failed-flush contract

If Graphiti submission fails:

1. the exact batch is restored to the same agent buffer;
2. that retained batch is marked as blocked from autonomous idle retry;
3. the five-minute scheduler MUST NOT repeatedly hammer Graphiti with the same failed batch;
4. a later new completed turn clears the retry block and makes the retained data eligible again;
5. if that new turn makes the threshold true, retry may happen immediately; otherwise normal idle timing starts from the new turn.

This behavior is intentional for v0.1. **Bounded retry/backoff remains mandatory follow-up work** after the live connection is proven; it must not be forgotten or silently replaced by an infinite retry loop.

A safe gateway/plugin shutdown flush is also follow-up work after the actual lifecycle behavior is proven live.

## 7. Graphiti capture request

v0.1 uses the existing Graphiti MCP `add_memory` tool.

The plugin supplies at minimum:

```text
name
episode_body
group_id = ctx.agentId
source
source_description
```

The plugin MUST NOT generate or send a client episode UUID. Graphiti owns UUID creation.

One flushed batch becomes one Graphiti episode. The episode body contains completed turns in chronological order with explicit USER/ASSISTANT boundaries.

Graphiti `add_memory` is asynchronous. Queue acceptance is not persistence. For the first vertical slice, queue acceptance is logged accurately and persistence is verified through Graphiti/FalkorDB. Persisted-UUID tracking is roadmap work after the connection is proven.

The MCP API exposes richer metadata and extraction controls. v0.1 deliberately does not use them yet. After the basic path works, the plugin should forward useful information that OpenClaw already knows rather than inventing data or throwing useful provenance away.

## 8. Auto-recall

v0.1 performs automatic Graphiti recall from OpenClaw `before_prompt_build` using the current user-side prompt text from the verified hook contract.

The recall query MUST NOT intentionally include OpenViking injected context, Graphiti injected context, or a fully assembled model prompt.

The first vertical slice calls Graphiti `search_memory_facts` scoped to exactly the current agent's `group_id`. Search results are rendered into one bounded XML block and returned as transient prompt context.

Canonical v0.1 wrapper:

```xml
<graphiti-context>
Source: graphiti-auto-recall
...
</graphiti-context>
```

The model may see both systems' injected blocks:

```text
OpenViking -> model <- Graphiti
```

Neither system should intentionally persist the other's raw injected block.

## 9. Cross-memory isolation defense

Primary isolation comes from lifecycle boundaries: capture clean conversation turns, not the assembled model prompt.

Defense in depth in this plugin:

- strip `<graphiti-context>...</graphiti-context>` before Graphiti capture/query processing;
- strip `<relevant-memories>...</relevant-memories>`;
- strip `<openviking-context ...>...</openviking-context>`;
- strip only these known wrappers, not arbitrary user XML.

The current `piqnyx/openviking-openclaw-plugin` already strips its two own injection forms, `<relevant-memories>` and `<openviking-context>`, before OpenViking capture. It does **not** currently strip `<graphiti-context>`. That asymmetry is known and is explicitly deferred to a small separate OpenViking patch/release after the first Graphiti live proof.

This filtering is a safety net, not magic semantic isolation. A model may naturally paraphrase a remembered fact in its visible answer; the invariant is that raw injected XML blocks are not intentionally fed back into a memory store.

## 10. v0.1 configuration

Default configuration:

```json
{
  "baseUrl": "http://127.0.0.1:8000/mcp/",
  "autoCapture": true,
  "autoRecall": true,
  "captureBatchTurns": 10,
  "captureBatchIdleFlushSeconds": 300,
  "requestTimeoutMs": 45000,
  "recallLimit": 6,
  "recallQueryMaxChars": 2000,
  "recallMaxInjectedChars": 4000,
  "captureMaxChars": 12000,
  "logOperations": true,
  "logLevel": "info",
  "logContent": false
}
```

For the first live proof use:

```json
{
  "captureBatchTurns": 1,
  "logOperations": true,
  "logLevel": "debug",
  "logContent": true
}
```

`logContent=true` is a temporary diagnostic mode. It logs the sanitized capture episode body, recall query, recalled fact texts, and final injected Graphiti block. It MUST be switched back off after live inspection unless there is a deliberate reason to keep conversation content in gateway logs.

`captureMaxChars` is currently diagnostic rather than destructive: if a batch exceeds the configured value, v0.1 warns and submits the intact batch instead of silently truncating memory. Final byte/character cap and splitting semantics are roadmap work.

Removed donor-era options such as capture modes, agent tools, separate fact/node limits, cooldowns, and connection timeout knobs are intentionally not accepted by v0.1 configuration.

## 11. Logging and diagnostics

All plugin logs go through the OpenClaw plugin logger, not stdout/stderr ad-hoc prints. OpenClaw therefore owns file/console routing, JSONL formatting, rotation, redaction, and global log-level filtering.

Plugin levels:

- `error`: capture submission failure, invalid plugin configuration;
- `warn`: recall failure, invalid/missing agent identity, oversize capture warning;
- `info`: plugin loaded, capture queue accepted, recall completed;
- `debug`: buffer state, skip reasons, flush start and diagnostic content events.

Messages use stable event names such as:

```text
plugin_loaded
capture_buffered
capture_turn
capture_flush_start
capture_payload
capture_queue_accepted
capture_flush_failed
capture_skipped
recall_query
recall_payload
recall_completed
recall_failed
recall_skipped
```

Useful fields include:

```text
agentId
group_id
bufferTurns
flush reason
batch turns
chars
queue accepted / failure
retained=true on failed capture
automaticRetry=false on retained v0.1 failures
recall result count
injected chars
request duration
```

Diagnostic content is one-line escaped in the log message so the surrounding OpenClaw JSONL remains parseable.

## 12. v0.1 live acceptance test

v0.1 is accepted only after all of these are demonstrated on the real server:

1. Plugin loads without occupying the OpenViking or memory slots.
2. With `captureBatchTurns=1`, one completed turn causes one Graphiti submission.
3. Debug logs show the sanitized capture payload actually sent to Graphiti.
4. FalkorDB UI shows resulting graph data and Graphiti-created entities/facts/relationships.
5. A later turn in the same conversation receives a relevant `<graphiti-context>` auto-recall block.
6. Debug logs show the recall query, returned fact texts, and exact Graphiti block injected into the model.
7. The model can distinguish/report the OpenViking and Graphiti XML context blocks it received.
8. Another conversation using the same agent recalls information captured from the first conversation.
9. Another agent does not recall or search the first agent's Graphiti memory.
10. OpenViking behavior remains working.
11. Injected Graphiti/OpenViking blocks are not directly recaptured merely because they were injected into the model prompt.
12. After diagnostics are complete, `logContent` is returned to `false`.

## 13. Development and test policy

- npm only; commit `package-lock.json`;
- TypeScript with strict type checking;
- build/test/typecheck in CI;
- work directly on `main` with small coherent commits; no routine side branches;
- do not modify unrelated repositories or server components without explicit discussion;
- do not make destructive database changes from this plugin;
- when live server evidence is required, provide exact minimal commands rather than asking the owner to perform work the development environment can do itself;
- tests must exercise behavior, failure modes, routing boundaries, payload shape, and concurrency invariants; tautological tests written merely to satisfy coverage are not acceptable;
- never weaken production behavior merely to make a test pass; fix the design or the test fixture according to the actual contract.

See `TESTING.md` for the test philosophy and required invariant classes.

This codebase is the base for future functionality. v0.1 should be small, but not throwaway.
