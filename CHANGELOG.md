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
- Optional history-aware recall queries with separate limits for recent messages, history characters, total query characters, retrieved facts and injected characters.
- Raw `llm_input` diagnostics showing the assembled system prompt, prompt and history that OpenClaw exposes immediately before model submission.
- Recall diagnostics that distinguish retrieved, injected and budget-skipped facts.
- Defense-in-depth stripping of Graphiti/OpenViking injected context before capture/recall queries.
- Structured logging with opt-in raw content diagnostics.
- Regression tests for identity/session isolation, arbitrary role sequences, timeout/limit batching, abort capture, FIFO/retry, UUID continuity, Saga recovery, backend status, MCP shapes, logging and context stripping.

### Added (agent tools)

- `graphiti_recall`, `graphiti_search_entities`, `graphiti_episodes`, `graphiti_store` and `graphiti_status`, registered when the host exposes a tool API and `agentTools` is enabled.
- Each tool resolves its agent from the invocation context and passes it as the Graphiti group; an excluded session cannot call them at all.
- `graphiti_store` writes standalone episodes with no saga, so agent notes cannot fork a dialog's episode chain.
- README documents every configuration key and every tool, including why no destructive tool is offered.
- The plugin manifest declares the `tool` activation capability and lists the tools in `contracts.tools`; the host publishes only declared tools, so a runtime registration alone leaves agents with none.

### Added (durability and session filtering)

- Durable capture spool schema version 2 with automatic migration of version 1 files.
- Per-session transcript watermarks in the spool, so a gateway restart neither replays a captured tail nor drops a turn whose `agent_end` never fired.
- Reserved episode identity (`uuid`, `name`, `batchNumber`, predecessor) persisted before submission.
- Restart reconciliation through read-only `get_saga`: a confirmed batch is dropped, an unconfirmed one is replayed with the same caller UUID instead of a new one.
- `excludeSessionPatterns` config key: regular expressions tested against the session key and the run trigger, applied to both capture and recall. It replaces the hardcoded cron/heartbeat/subagent/slug-generator filtering, whose behaviour is now the default value of the list.
- Regression coverage for restart replay, watermark resume, spool write failures, schema migration and session exclusion.

### Changed

- Episode UUIDs are derived from the batch (agent, saga, batch number, body) instead of generated randomly, so two callers preparing the same batch reserve the same UUID and Graphiti merges the second submission onto the same node. Reservation still happens before the request and the server still echoes the value back.

### Fixed

- One capture pipeline per process instead of one per `register()` call. OpenClaw registers the plugin once per host surface, so a start with unsent messages gave every instance the same restored buffer and every instance flushed it: one batch became several episodes with the same name and different UUIDs, and the saga's `NEXT_EPISODE` chain forked. Observed live after a restart with a non-empty spool.
- The backend queue poller now runs once per process rather than once per registration.
- The durable watermark advances only after a delta is buffered, so a delta the engine refused is observed again by the next process instead of being recorded as captured.
- The transcript delta tracker no longer keeps the full transcript of every session it has ever seen.
- Reconciling a restored batch no longer re-hydrates a sequence this process already established, which could move the batch number backwards.
- The MCP client retries only transport failures; a tool error whose text mentioned a session no longer causes a second submission of the same episode.
- Concurrent first MCP calls share one handshake instead of racing two sessions.
- Hydration state lives inside the episode sequence tracker instead of a parallel set that had to be kept in sync by hand.
- Capturing for an agent missing from `agents` is reported once instead of silently using default participant names.
- A failed spool write no longer aborts capture or discards the remainder of an observed transcript delta.
- A spool write failure after Graphiti acceptance is no longer reported as a capture transport failure.
- An empty plugin runtime can no longer delete a spool file created by another live runtime.
- Background runs (cron, heartbeat, subagent) no longer receive injected `<graphiti-context>`.
- Runtime tests no longer read or write the real OpenClaw state directory.

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
- Content diagnostics still require `logOperations=true`, `logLevel=debug`, and `logContent=true`, but are emitted through the INFO sink so they remain visible in OpenClaw journald.
- Recall query truncation preserves the newest tail rather than the oldest prefix.
- Recall memory wrapper now labels retrieved memory as non-instructional and gives current conversation priority on conflict.
- Recall defaults are now `recallLimit=8`, `recallQueryMaxChars=6000`, `recallMaxInjectedChars=8000`, with six recent history messages and a 4000-character history budget enabled by default.

### Known limitations

- Active buffers, transcript-delta snapshots and unsent plugin FIFO state are in-memory and are lost on Gateway/plugin process restart. Persisted Saga continuity itself is recovered from Graphiti.
- No explicit byte-size cap exists for capture requests yet.
- Recall cooldown and agent-visible `graphiti_*` tools remain deferred until recall live acceptance is complete.
- Raw content diagnostics may contain sensitive conversation and memory data and should be disabled after controlled testing.
