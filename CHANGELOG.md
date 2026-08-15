# Changelog

All notable changes to `graphiti-openclaw-plugin` are tracked here.

## 0.1.0 - unreleased

### Added

- Slot-less OpenClaw companion plugin with strict `ctx.agentId -> Graphiti group_id` routing.
- Automatic message-delta capture from full `agent_end.messages` transcript snapshots.
- Per-session active buffers and one FIFO queue per agent.
- Hard message-count batching plus inactivity flush for every non-empty buffer.
- Caller-reserved episode UUIDs stable across transport retries.
- Deterministic Saga episode naming and predecessor chaining.
- Lazy Saga restart recovery through Graphiti `get_saga`.
- Transport/MCP failure retention with automatic bounded-interval retry of the FIFO head.
- Backend asynchronous failure monitoring through `get_queue_status`.
- Error-only OpenClaw plugin session/UI status for capture/backend failures.
- Streamable HTTP MCP client for capture and recall.
- Automatic bounded `<graphiti-context>` recall injection.
- Defense-in-depth stripping of Graphiti/OpenViking injected context before capture/recall queries.
- Structured logging with opt-in raw content diagnostics.
- Regression tests for identity/session isolation, arbitrary role sequences, timeout/limit batching, abort capture, FIFO/retry, UUID continuity, Saga recovery, backend status, MCP shapes, logging and context stripping.

### Changed

- Capture atomic unit is now an individual sanitized `user|assistant` message. The old completed `user+assistant` turn model has been removed.
- Consecutive same-role messages are preserved exactly in observed order.
- `event.success=false` no longer discards new conversation messages by itself.
- `bufferLimit` counts messages and accepts any integer `1..1000`; evenness is not required.
- A one-message buffer is valid and may flush on inactivity.
- Queue entries persist their detach reason (`limit` or `timeout`) instead of reconstructing it later.
- Capture batching is isolated by session while processing remains FIFO per agent.
- Failed capture submissions retain the queue head rather than dropping it.
- Graphiti queue acceptance is no longer treated as proof of persistence; terminal backend processing failure is monitored separately.

### Known limitations

- Active buffers, transcript-delta snapshots and unsent plugin FIFO state are in-memory and are lost on Gateway/plugin process restart. Persisted Saga continuity itself is recovered from Graphiti.
- No explicit byte-size cap exists for capture requests yet.
- Recall tuning/cooldown and agent-visible `graphiti_*` tools remain deferred until capture live acceptance is complete.
