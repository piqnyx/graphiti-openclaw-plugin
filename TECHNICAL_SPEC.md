# Graphiti OpenClaw Plugin — Technical Specification

_Status: active implementation contract, 2026-08-15._

## Identity and isolation

- `group_id` is always the current OpenClaw `ctx.agentId`.
- `saga` is always the current `ctx.sessionKey`.
- FalkorDB physical graph isolation is owned by the `piqnyx/graphiti` fork.
- Active capture buffers are keyed by `agentId + sessionKey`.
- Each agent owns one FIFO processing queue; different agents process independently.

## Capture source

OpenClaw `agent_end` supplies a transcript snapshot, not a guaranteed single new turn. Capture therefore:

1. rejects heartbeat, cron, subagent and slug-generator sessions;
2. extracts only `user|assistant` text messages;
3. strips Graphiti/OpenViking injected context and known conversation metadata;
4. computes a per-session delta against the prior sanitized snapshot;
5. appends every new message individually to the session buffer.

`event.success=false` does not discard new messages. This preserves user messages from stopped/aborted runs.

There is no completed-turn/pair abstraction in capture. Consecutive users or assistants are valid.

## Batching

- `bufferLimit`: integer `1..1000`, measured in actual messages.
- `bufferTimeout`: integer seconds, minimum 30.
- The internal ticker interval is 30 seconds.
- Reaching `bufferLimit` detaches the batch immediately.
- Any non-empty buffer is eligible for inactivity flush, including a single user message.
- `QueueEntry.enqueuedAt` is captured at detach and becomes Graphiti `reference_time`.
- `QueueEntry.reason` is fixed at detach as `limit` or `timeout` and is preserved through retry.

## Episode body

Each Graphiti episode uses `source=json` and contains canonical actors plus ordered messages:

```json
{
  "participants": { "user": "...", "assistant": "..." },
  "messages": [
    { "role": "user", "text": "..." },
    { "role": "user", "text": "..." },
    { "role": "assistant", "text": "..." }
  ]
}
```

Role alternation is not required.

## Saga sequencing

For each `agentId + sessionKey`, the sequence tracker reserves a caller UUID before MCP submission. Until acceptance, retries reuse the same UUID.

Episode names are:

```text
<session UUID tail>-<1-based batch number>
```

For every episode after the first:

```text
previous_episode_uuids = [last accepted episode UUID]
saga_previous_episode_uuid = last accepted episode UUID
```

On plugin restart, `get_saga(sessionKey, agentId)` restores persisted episode count and last episode UUID before preparing the next batch.

## Failure behavior

### Before MCP acceptance

Transport/MCP errors retain the exact FIFO head. Later batches cannot overtake it. Retry uses the same content, detach reason, Saga state and caller UUID. An error-only plugin session status is published best-effort.

### After MCP acceptance

Graphiti processing is asynchronous. The plugin polls `get_queue_status(group_id)` every 30 seconds. A terminal backend failure publishes an error-only session status. Health-check failure reports that persistence cannot be verified. A proven blocked status is not overwritten by a weaker health-check error.

## Cross-memory sanitization

Capture strips raw blocks for:

```text
<graphiti-context>...</graphiti-context>
<openviking-context>...</openviking-context>
<relevant-memories>...</relevant-memories>
```

Recall output may be visible to the model but must not be intentionally recaptured as raw memory input.

## Background exclusion

Capture rejects runs identified as heartbeat, cron, subagent, or slug-generator before transcript delta/buffering.

## In-memory boundary

Active buffers, transcript snapshots and unsent plugin queue entries are process memory. Persisted Saga sequencing survives restart through `get_saga`, but pre-MCP data is not currently crash-durable.

## Recall

Recall remains separate from capture stabilization. It is agent-scoped, strips injected memory blocks from the query, calls Graphiti fact search, escapes returned content, and injects it only inside `<graphiti-context>`.
