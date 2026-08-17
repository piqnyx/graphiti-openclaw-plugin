# Changelog

All notable changes to `graphiti-openclaw-plugin` are tracked here.

## 0.4.0 - 2026-08-17

### Added (durability)

- Batches Graphiti accepted are kept until their episode is seen in the graph, and resent until it is. Acceptance only means the backend took the batch; extraction happens later, and when it fails — an unreachable model, a reply truncated at the token ceiling — nothing tells the plugin and the episode never appears. Retries are unbounded with a wait that doubles from 30 seconds to an hour, and the ledger is bounded by size (50 GB) rather than by attempts, because the failure this survives is a backend that comes back in hours.
- Batch numbers are never reused: a restart resumes from the larger of what the backend has processed and what this process already issued. Trusting the backend alone gave one dialog two different episodes named `-22` while the first was still queued.
- `graphiti_status` reports what is waiting for confirmation, how old the oldest is, what keeps failing to land, and anything dropped for space.


## 0.3.0 - 2026-08-17

### Changed (breaking: tool names)

- Six agent tools become four. `graphiti_recall` and `graphiti_search_entities` merge into `graphiti_search`; `graphiti_context` becomes `graphiti_browse`; `graphiti_episodes` is gone, since its only real use was supplying an episode name that search now returns itself. Update the agent's allowlist to `graphiti_search`, `graphiti_browse`, `graphiti_note`, `graphiti_status`.
- `graphiti_search` returns facts, entities and episodes from one retrieval pass, each with the reranker's score. Episodes are a result type of their own, matched on the words of the conversation, so a query can reach the dialog without going through a fact. Requires the fork tool `search_memory_combined`.
- Every hit lists episode anchors such as `8248439450-12` with a count of how many results point at that episode — a number the agent can act on without knowing anything about provenance. Entity anchors are derived from the facts touching the entity, since an entity carries no provenance of its own.
- Facts superseded by a newer one are hidden unless `include_outdated` asks for them: such a fact is not false, but repeating it as current knowledge is.
- Per-type limits (`facts`, `entities`, `episodes`), zero excluding a type. Time filters distinguish when a fact was true (`valid_from`/`valid_to`) from when it was recorded (`discussed_within_days`).
- `graphiti_browse` expands several anchors in one call, including anchors from different hits. Its budgets are configuration — `browseChars`, `browseMaxChars`, `browseMaxEpisodes`, `browseMaxTotalChars` — and what does not fit is reported as omitted rather than dropped in silence.

## 0.2.0 - 2026-08-17

### Changed

- `graphiti_store` is now `graphiti_note`, and it no longer writes a standalone episode. The note is appended to the open batch of the conversation it was made in and leaves with it, so it belongs to a dialog, takes its place in that dialog's chain, and cannot fork the chain — the pipeline that owns the chain does the writing. Update the OpenClaw allowlist: `graphiti_store` no longer exists.
- Every tool, read-only ones included, refuses a run with no session. Memory belongs to a conversation; a call from outside one has no dialog to read from and nowhere to write to.

### Added

- TTS directives the model writes into its own reply (`[[tts:…]]`, `[[tts:text]]…[[/tts:text]]`, `[[audio_as_voice]]`) are stripped before capture. The gateway removes them from the visible text, but capture reads the model's raw output, so voice ids and model names were reaching extraction as if they were facts.

### Fixed

- The gateway's runtime context block (`<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>` … `<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`) is stripped before capture. It carries the chat id, the sender's name and username, session identifiers and the recent traffic of *other* sessions; captured verbatim it put another conversation into this agent's episode, and extraction then built entities and facts out of it. Seen live in agent `red`.
- The default `excludeSessionPatterns` now cover OpenClaw's own setup probes (`:setup-inference:`, `incognito-probe`). A model-setup probe is a machine verifying a configuration, not a conversation, and one of them wrote a whole saga into a live graph before this was noticed.
- A dialog with nothing committed yet no longer reports "batch number 0 is missing". The numbering check ran its range from zero when it had seen no episodes, so every brand-new dialog accused itself of having lost a batch.

## 0.1.1 - 2026-08-17

### Fixed

- `graphiti_status` no longer reports itself as a failed tool call when it finds a defect. `ok` now says whether the tool ran; `healthy` and `problems` say what it found. A diagnostic that reports damage has done its job, not failed at it.
- A note written by `graphiti_store` is no longer counted as an episode detached from a dialog. Notes carry no saga by design, and every one of them was being reported as orphaned; the note's `source_description` is now passed to `get_graph_stats`, which excludes it.

## 0.1.0 - 2026-08-17

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

- `graphiti_recall`, `graphiti_search_entities`, `graphiti_context`, `graphiti_episodes`, `graphiti_store` and `graphiti_status`, registered when the host exposes a tool API and `agentTools` is enabled.
- `graphiti_context` reads the conversation behind a fact, resolving either a query through the fact's source episodes or a named episode directly, and widening the window on request. Requires the fork tool `get_episodes_by_ref`.
- `graphiti_status` reports graph size, the most connected entities, memory age and integrity checks — duplicated episode names, episodes with no dialog, broken `NEXT_EPISODE` chains, facts with no source episode, isolated entities. Requires the fork tool `get_graph_stats`; an unavailable report costs one line rather than the whole status.
- Search tool descriptions point at the OpenViking tools when nothing is found, matching the reciprocal hint in that plugin.
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
