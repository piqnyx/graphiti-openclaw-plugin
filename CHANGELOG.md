# Changelog

All notable changes to `graphiti-openclaw-plugin` are tracked here.

## 0.1.0 - unreleased

Initial live vertical slice.

### Added

- Slot-less OpenClaw companion plugin with no memory/context-engine slot ownership.
- Strict `ctx.agentId -> Graphiti group_id` routing.
- Automatic capture from completed USER + final ASSISTANT turns.
- One shared in-memory `Map<agentId, BufferState>` across all conversations handled by the loaded plugin instance.
- Per-agent threshold batching and one shared idle scheduler.
- Graphiti Streamable HTTP MCP client for `add_memory` and `search_memory_facts`.
- Automatic bounded `<graphiti-context>` recall injection.
- Defense-in-depth stripping of `<graphiti-context>`, `<relevant-memories>`, and `<openviking-context ...>` before Graphiti capture/recall queries.
- Structured plugin logging with `error`, `warn`, `info`, and `debug` levels.
- Opt-in raw diagnostic content logging through `logContent`.
- Behavioral tests for agent isolation, batching, idle scheduling, concurrent turns, failed-flush retention, MCP request shapes, runtime hook wiring, logging, XML escaping, and context stripping.
- `TECHNICAL_SPEC.md`, `TODO.md`, and `TESTING.md` as maintained project documents.

### Changed

- Capture batching is keyed only by agent identity, never session identity.
- `session_end` is intentionally not used to flush capture buffers.
- Failed capture submissions restore the batch and block autonomous idle retry until a new turn arrives.
- Idle scheduler timer is unreferenced so it does not keep Node alive by itself during shutdown/tests.
- `captureMaxChars` is currently diagnostic only: oversized batches log a warning and are still submitted intact.

### Known limitations before production release

- Retained capture buffers are currently unbounded if Graphiti remains unavailable while new turns continue arriving. A bounded overflow policy must be designed before production release; data must never be dropped silently.
- No bounded retry/backoff yet.
- No persistence-state tracking after Graphiti queue acceptance yet.
- Buffer contents are in-memory and are lost on Gateway/plugin process restart.
- Current OpenViking fork strips its own recall wrappers but does not yet strip `<graphiti-context>` from its capture path; that reciprocal patch is tracked separately.
- Agent-visible `graphiti_*` tools are intentionally deferred until automatic capture/recall passes live acceptance.
