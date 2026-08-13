# Testing policy

Tests in this repository exist to catch real regressions in memory routing, capture, recall, batching, and failure behavior. A green suite is not a goal by itself; it is evidence that important invariants still hold.

## Required test classes

Every non-trivial behavior should be tested through at least one externally observable contract, not only through the implementation detail that happens to produce it.

High-value invariants include:

- **identity isolation** — `ctx.agentId` is the only source of Graphiti `group_id`, and two agents never share a batch or search scope;
- **conversation independence** — sessions may change while the same agent retains one memory personality and one capture buffer;
- **capture correctness** — only the trailing completed USER + final ASSISTANT turn is captured, without tool noise or injected memory wrappers;
- **cross-memory filtering** — Graphiti/OpenViking XML wrappers are removed while unrelated user XML survives;
- **batch integrity** — threshold and idle flushes contain complete turns in chronological order;
- **concurrency** — turns arriving during an in-flight flush are not lost, duplicated, or interleaved into the request already in flight;
- **failure retention** — a failed batch remains buffered and v0.1 does not autonomously retry it forever;
- **retry unblock semantics** — a later real turn makes retained data eligible again;
- **MCP shape** — tool name, arguments, session handling, `group_id`, limits, and absence of client-generated UUID match the Graphiti contract;
- **recall safety** — query sanitization happens before search, result markup is escaped, and the injected wrapper cannot be broken by fact text;
- **logging privacy controls** — content is absent unless explicitly enabled, and diagnostic payloads remain one-line escaped.

## What not to do

Do not add tests that merely restate constants, mirror the implementation line-for-line, or prove that a mock returns what the mock was told to return.

Do not change production semantics solely to satisfy a failing test. First decide which side is wrong according to `TECHNICAL_SPEC.md`, the verified OpenClaw hook contract, and the Graphiti MCP contract.

Do not hide race conditions with arbitrary sleeps when a state transition can be observed directly. Timing tests should use bounded polling and generous margins when real timers are the behavior under test.

Do not weaken negative assertions. Isolation, sanitization, destructive operations, and failure recovery need explicit tests for what **must not** happen.

## Test layers

1. **Pure behavior tests** cover config, identity, text extraction/sanitization, XML rendering, and buffer state transitions.
2. **Protocol tests** exercise the real `GraphitiMcpClient` request/response code against a controlled in-process HTTP/fetch boundary.
3. **Plugin runtime tests** register the actual plugin against a fake OpenClaw hook API and drive `agent_end` / `before_prompt_build` through the MCP boundary.
4. **Live acceptance** is manual against the real OpenClaw + Graphiti + FalkorDB stack and is never replaced by mocks.

Production Graphiti/FalkorDB credentials and data do not belong in CI. A future live integration job must use an explicitly disposable test backend.
