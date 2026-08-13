# Graphiti OpenClaw Plugin — Initial Technical Specification

Status: active specification for the first live vertical slice.

This file is the authority for v0.1. Older handoffs, donor plugins, experiments, and previous design notes are non-authoritative when they conflict with this document.

## Implementation status — 2026-08-13

The code-side v0.1 vertical slice is implemented on `main` and passes npm CI (`typecheck + build + tests`). The OpenClaw 2026.8.1 hook contract was checked against core commit `2ce420091e136da4c83e65071c6caea68f3b1ac1` before binding the runtime hooks.

Implemented:

- slot-less plugin manifest and npm/TypeScript build;
- `agent_end` completed-turn extraction;
- strict `ctx.agentId -> group_id` identity;
- one in-memory capture buffer per agent, shared across that agent's conversations;
- completed-turn threshold flush and idle flush;
- failed flush retention without autonomous retry loops;
- Graphiti Streamable HTTP MCP client for `add_memory` and `search_memory_facts`;
- automatic bounded `<graphiti-context>` recall injection;
- Graphiti/OpenViking wrapper stripping before Graphiti capture/query processing;
- concise operational logging and unit tests.

Still pending: the real-server acceptance sequence in section 12. Until that passes, v0.1 is code-complete but not live-accepted.

## 1. Goal

Build the smallest production-shaped OpenClaw companion plugin that proves the complete path:

1. OpenClaw completed turns are auto-captured.
2. Captured turns reach the existing Graphiti MCP server.
3. Graphiti persists them into the existing FalkorDB graph and builds entities/facts/relationships.
4. Relevant Graphiti memory is automatically recalled before a model turn.
5. Recall works in the same conversation and across different conversations of the same agent.
6. Different OpenClaw agents remain strictly isolated.
7. OpenViking continues operating independently and unchanged.

v0.1 is intentionally small. Agent-visible Graphiti tools are not part of the first live test.

## 2. Existing architecture and hard boundaries

The plugin is a slot-less companion plugin.

```text
OpenClaw
├── OpenViking                  existing contextEngine, untouched
├── existing memory component   existing memory slot, untouched
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
- modify OpenViking;
- modify OpenClaw core;
- modify `openclaw.json` itself;
- bypass Graphiti through direct Redis/FalkorDB queries.

Any need to change another subsystem is a stop-and-discuss event before making the change.

## 3. Identity and isolation

The authoritative Graphiti identity is:

```text
OpenClaw ctx.agentId -> Graphiti group_id
```

Rules:

- `group_id` is never supplied by the model.
- `group_id` is never derived from conversation/session identity.
- no hardcoded list of agent IDs exists in the plugin.
- missing/invalid `ctx.agentId` fails closed for capture/recall.
- every Graphiti operation performed for an agent uses that agent's resolved `group_id`.

The existing `piqnyx/graphiti` fork contains FalkorDB group isolation fixes, including request-scoped driver handling for concurrent `group_id` operations. The plugin relies on that backend contract but does not patch it.

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

Capture buffers are therefore keyed by **agentId only**, not by session ID/session key:

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

Per-agent behavior:

```text
agent_end
  -> extract completed turn
  -> append to buffer[agentId]
  -> reset that agent's idle timer

if turns >= captureBatchTurns
  -> flush all currently buffered turns for that agent

if no new completed turn arrives for captureBatchIdleFlushSeconds
  -> flush all currently buffered turns for that agent
```

Requirements:

- agent buffers never mix;
- concurrent flushes for the same agent must not duplicate/interleave a batch;
- turns arriving during a flush remain safe for the next batch;
- a failed Graphiti submission must not silently discard the batch;
- no session boundary changes the agent-buffer semantics.

v0.1 restores a failed batch to the same agent buffer and does not start an autonomous retry loop. A later new turn can make the retained batch eligible again. Explicit bounded retry/backoff is deferred until after the first live proof.

A safe gateway/plugin shutdown flush is desirable, but must not complicate the first vertical slice until the actual OpenClaw lifecycle contract is verified.

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

OpenViking and Graphiti should not consume each other's injected blocks as memory input.

## 9. Cross-memory isolation defense

Primary isolation comes from lifecycle boundaries: capture clean conversation turns, not the assembled model prompt.

Defense in depth in this plugin:

- strip `<graphiti-context>...</graphiti-context>` before Graphiti capture/query processing;
- strip the OpenViking injection forms used by the installed plugin: `<relevant-memories>...</relevant-memories>` and `<openviking-context ...>...</openviking-context>`;
- strip only known wrappers, not arbitrary user XML.

This filtering is a safety net, not the architecture. A model may naturally paraphrase a remembered fact in its visible answer.

OpenViking itself is not modified in v0.1. Symmetric Graphiti-tag stripping in OpenViking is a separate reviewed change only if later testing proves it necessary.

## 10. v0.1 configuration

Keep the first config intentionally small:

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
  "logOperations": true
}
```

For the first live proof, override only `captureBatchTurns` to `1` so every completed turn is immediately submitted.

`captureMaxChars` is currently diagnostic rather than destructive: if a batch exceeds the configured value, v0.1 warns and submits the intact batch instead of silently truncating memory. Final cap/splitting semantics are chosen after observing real Graphiti episodes.

Separate capture modes, agent-visible tools, node/fact-specific limits, cooldowns, background-turn capture, persistence polling, and advanced extraction controls are future work unless required for correctness.

## 11. Logging

Logs must not print secrets, full prompts, full conversation bodies, or full recalled memory bodies.

Useful v0.1 fields:

```text
agentId
group_id
buffer turns
flush reason: threshold | idle
batch turns
queue accepted / failure
recall result count
injected chars
request duration
```

## 12. v0.1 live acceptance test

v0.1 is accepted only after all of these are demonstrated on the real server:

1. Plugin loads without occupying the OpenViking or memory slots.
2. With `captureBatchTurns=1`, one completed turn causes one Graphiti submission.
3. FalkorDB UI shows resulting graph data and Graphiti-created entities/facts/relationships.
4. A later turn in the same conversation receives a relevant `<graphiti-context>` auto-recall block.
5. The model can distinguish/report the OpenViking and Graphiti XML context blocks it received.
6. Another conversation using the same agent recalls information captured from the first conversation.
7. Another agent does not recall or search the first agent's Graphiti memory.
8. OpenViking behavior remains working and unchanged.
9. Injected Graphiti/OpenViking blocks are not directly recaptured merely because they were injected into the model prompt.

## 13. Development policy

- npm only; commit `package-lock.json`.
- TypeScript with strict type checking.
- build/test/typecheck in CI.
- work directly on `main` with small coherent commits; no routine side branches.
- do not modify unrelated repositories or server components without explicit discussion.
- do not make destructive database changes from this plugin.
- when live server evidence is required, stop and provide exact minimal commands for the owner to run.

This codebase is the base for future functionality. v0.1 should be small, but not throwaway.
