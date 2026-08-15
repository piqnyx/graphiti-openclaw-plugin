# TODO

Roadmap for `graphiti-openclaw-plugin`. Current behavior lives in `TECHNICAL_SPEC.md`, `BUFFER_SPEC.md`, and tests. Git history already preserves obsolete experiments, so this file should not masquerade as a museum.

## Current live acceptance

- Pull/build the latest `main` after the message-delta migration audit.
- Run capture with `bufferLimit=6` and `bufferTimeout=300` across multiple sessions of one agent.
- Exercise consecutive-user and stopped-run cases (`U U U A`, user-only timeout, aborted run followed by another user message).
- Confirm each detached batch appears once in FalkorDB with the expected Saga, episode name, UUID and predecessor chain.
- Confirm different OpenClaw agents still map to physically isolated Falkor graphs.
- Deliberately test a transport failure and a terminal backend processing failure so error-only session status is proven live.
- Keep recall out of capture acceptance until capture is stable; recall tuning is a separate stage.
- After live proof, set `logContent=false` unless detailed diagnostics are actively needed.

## Production hardening still open

1. **Crash-durable pre-MCP spool.** Active buffers, transcript snapshots and unsent plugin FIFO state are currently in-memory. Persist them only if Gateway restart loss proves operationally important.
2. **Backlog bounds.** Define byte/message bounds for retained unsent batches without silent data loss.
3. **Byte-aware request bounds.** Define explicit split/reject behavior before enforcing a hard request-size cap.
4. **Recall cooldown and tuning.** Prevent an unhealthy recall endpoint from being hit on every prompt and tune result selection from real graph data.
5. **Safe shutdown policy.** Decide whether Gateway shutdown should synchronously flush, spool, or intentionally leave in-memory state ephemeral.
6. **Agent-visible tools.** Add `graphiti_recall/store/forget/status` only after automatic capture/recall are proven and destructive isolation is designed.

## Permanent capture invariants

- `group_id = ctx.agentId`.
- `saga = ctx.sessionKey`.
- One active buffer per `agentId + sessionKey`; one FIFO queue per agent.
- Capture atomic unit is an individual sanitized `user|assistant` message, not a turn/pair.
- `bufferLimit` counts messages and may be odd; valid range is `1..1000`.
- Every non-empty buffer is timeout-eligible, including user-only buffers.
- Failed queue head is retained and retried with the same caller UUID and immutable detach reason.
- Backend queue acceptance is not treated as persistence; `get_queue_status` monitors terminal asynchronous failures.
- Background heartbeat/cron/subagent and slug-generator sessions never enter capture.
- Raw Graphiti/OpenViking recall wrappers are stripped before capture.

## Graphiti/Falkor follow-ups

- Keep the fork's caller UUID, Saga state recovery, request-scoped Falkor isolation and reliable per-group queue patches covered by tests.
- Maintain a read-only graph validator for Saga membership, `NEXT_EPISODE` chain integrity, episode ordering and optional semantic expectations.
- Treat an episode with zero extracted entities as a semantic warning by default, not structural corruption; a test case may promote it to failure when specific entities are expected.
- Never add reciprocal `NEXT_EPISODE` edges. `NEXT_EPISODE` is a directed chronological relation from predecessor to successor; reverse traversal is a query operation, not another edge.

## Recall / cross-memory

- Keep Graphiti-side stripping of `<graphiti-context>`, `<relevant-memories>`, and `<openviking-context>` covered by regression tests.
- Keep the reciprocal OpenViking `<graphiti-context>` filter in its own repository and tests.
- Do not promise semantic isolation from model paraphrases; the invariant is that raw injected blocks are not intentionally recaptured.
