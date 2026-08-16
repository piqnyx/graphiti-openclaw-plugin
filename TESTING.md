# Testing policy

Tests in this repository exist to catch real regressions in memory routing, capture, recall, batching, saga continuity, and failure behavior. A green suite is evidence only when the assertions match the current architecture.

## Required invariants

- **identity isolation** — `ctx.agentId` is the only source of Graphiti `group_id`;
- **session isolation** — each `agentId + sessionKey` has its own active buffer and Saga state;
- **message-delta capture** — `agent_end.messages` is treated as a transcript snapshot; only newly observed `user|assistant` messages are buffered;
- **arbitrary role sequences** — `U U U A`, `A A`, and user-only tails are valid capture input;
- **abort retention** — `event.success=false` does not by itself discard newly observed conversation messages;
- **cross-memory filtering** — Graphiti/OpenViking recall wrappers are stripped from every captured message;
- **hard message batching** — `bufferLimit` counts individual messages, accepts any integer `1..1000`, and never assumes evenness or pairs;
- **timeout batching** — every non-empty buffer, including one message, is eligible after inactivity;
- **FIFO** — detached batches are ordered per agent; sessions may interleave but never overtake the agent queue head;
- **failure retention** — transport/MCP failure retains the exact queue head, detach reason, Saga sequence and caller-reserved UUID for retry;
- **backend failure visibility** — terminal asynchronous Graphiti queue failures are surfaced through error-only plugin session status;
- **restart Saga continuity** — `get_saga` restores persisted episode count and last UUID before the next accepted batch;
- **restart capture continuity** — a durable watermark resumes the transcript delta exactly where the previous process stopped: no replayed tail, no dropped turn;
- **restart replay safety** — a batch already confirmed by `get_saga` is dropped, an unconfirmed one is replayed with its reserved caller UUID, name and predecessor;
- **spool containment** — a failed durable write keeps every message in memory, is reported once, and is never surfaced as a capture transport failure;
- **session exclusion** — an excluded session produces no MCP traffic in either direction;
- **MCP shape** — caller UUID, `group_id`, `saga`, predecessor fields and `reference_time` match the fork contract;
- **recall safety** — query sanitization happens before search and injected XML cannot be broken by fact text;
- **logging privacy** — raw message/request content appears only with explicit debug content logging.

## Regression cases required for message capture

At minimum keep explicit coverage for:

```text
U A
U U U A
U A U U U A
7xU + A with bufferLimit=6
U followed by timeout
U on an aborted/stopped run
successive full snapshots without duplicate replay
snapshot rewrite/overlap fallback
```

## What not to do

Do not reintroduce `turn`, `pair`, even-limit, or minimum-two-message assumptions as compatibility helpers. They are not part of the capture contract anymore.

Do not change production semantics solely to satisfy a stale test. First decide which behavior matches `TECHNICAL_SPEC.md`, the verified OpenClaw hook contract, and the Graphiti MCP contract.

Do not hide race conditions with arbitrary sleeps when a state transition can be observed directly. Do not weaken negative assertions around isolation, sanitization, FIFO, UUID stability, or error retention.

## Test layers

1. Pure behavior tests: config, identity, sanitization, transcript delta and buffer transitions.
2. Protocol tests: real `GraphitiMcpClient` request/response code against a controlled HTTP/fetch boundary.
3. Plugin runtime tests: actual plugin registration and `agent_end` / recall hook behavior through the MCP boundary.
4. Live acceptance: real OpenClaw + Graphiti + FalkorDB. Mocks never replace this layer.

Production Graphiti/FalkorDB credentials and data do not belong in CI. Live validators must be read-only unless a deliberately disposable graph is selected.
