# TODO

Roadmap for `graphiti-openclaw-plugin`.

`TECHNICAL_SPEC.md` is authoritative for the active v0.1 slice. This file holds implementation tasks and future ideas. Completed items are removed rather than left as a graveyard of checkmarks, because repositories already have Git history for archaeology.

## v0.1 — live vertical slice

- Create npm/TypeScript project skeleton and committed `package-lock.json`.
- Add strict typecheck, build, unit tests, and GitHub Actions CI.
- Add OpenClaw plugin manifest as a slot-less companion plugin.
- Verify current OpenClaw hook contract used by the installed generation before binding runtime code.
- Implement strict config parsing/defaults:
  - `baseUrl` default `http://127.0.0.1:8000/mcp/`
  - `autoCapture=true`
  - `autoRecall=true`
  - `captureBatchTurns=10`
  - `captureBatchIdleFlushSeconds=300`
  - `requestTimeoutMs=45000`
  - `recallLimit=6`
  - `recallQueryMaxChars=2000`
  - `recallMaxInjectedChars=4000`
  - `captureMaxChars=12000`
  - `logOperations=true`
- Implement fail-closed `ctx.agentId -> group_id` resolver.
- Implement text sanitization for Graphiti/OpenViking injected wrappers and OpenClaw inbound metadata noise.
- Implement completed-turn extraction from `agent_end`: trailing USER + final ASSISTANT only.
- Exclude known synthetic/background OpenClaw runs when safely identifiable.
- Implement per-agent capture buffer keyed only by `agentId`.
- Implement threshold flush in completed turns.
- Implement per-agent idle flush timer.
- Make same-agent flush serialization duplicate-safe under concurrent turns.
- Preserve a failed batch instead of silently discarding it.
- Implement MCP client for the existing Graphiti server; no embedded backend/supervisor.
- Implement `add_memory` capture path without client-generated UUID.
- Implement Graphiti search path for auto-recall.
- Inject bounded recall as `<graphiti-context>...</graphiti-context>`.
- Add concise operation logs without prompt/memory/secret dumps.
- Add unit tests for isolation, extraction, sanitization, batching, idle flush, failed flush retention, recall bounds, and config validation.
- Build tracked runtime output if required by the same load pattern used by the local OpenClaw plugins.
- Prepare minimal installation/config snippet, but do not mutate `openclaw.json` from installer/plugin code.
- Run first live test with `captureBatchTurns=1`.
- Verify same-dialog recall.
- Verify cross-dialog recall for the same agent.
- Verify cross-agent isolation.
- Verify FalkorDB graph/entity/fact creation in the existing UI.
- Verify OpenViking continues working unchanged beside Graphiti.
- Verify the model can see both independent XML recall blocks while neither plugin intentionally captures the other's block.

## Immediately after v0.1 proves the connection

- Decide and implement safe gateway/plugin shutdown flush using the verified OpenClaw lifecycle contract.
- Track Graphiti `queue accepted -> processing -> persisted UUID | failed | timeout` instead of treating queue acceptance as persistence.
- Add bounded retry/backoff behavior for capture failures.
- Add auto-recall failure cooldown so an unhealthy Graphiti endpoint is not hammered every turn.
- Add richer structured diagnostics for queue state, persistence latency, recall latency, result counts, and injected chars.
- Tune recall search strategy and result rendering from real graph data.
- Decide whether separate node/fact limits add value; do not add knobs merely because another plugin had them.
- Decide whether `captureMaxChars` should cap a whole batch, individual turns, or both, based on live Graphiti behavior.
- Evaluate crash-safe local spool/persistence for unsent in-memory batches if gateway restarts become a practical loss mode.

## Agent-visible tools

Add only after auto-capture/auto-recall are proven. Tool descriptions must discourage unprompted calls because automatic memory flow is the default.

Planned names:

- `graphiti_recall` — explicitly search Graphiti memory when the user/agent asks to recall something or automatic recall is insufficient.
- `graphiti_store` — explicitly store a durable fact/decision when asked; derive `group_id` from tool context only.
- `graphiti_forget` — explicitly forget/remove Graphiti information when asked; destructive and strictly agent-scoped.
- `graphiti_status` — inspect this plugin/Graphiti connection and recent queue state without exposing secrets.

Rules:

- no tool accepts arbitrary `group_id`;
- all tools resolve identity from `ctx.agentId`;
- descriptions say not to call merely because memory exists;
- tools never become a substitute for auto-capture/auto-recall.

## Forget/delete safety

Before implementing `graphiti_forget`:

- inspect the then-current `piqnyx/graphiti` MCP schema for `get_entity_edge`, `delete_entity_edge`, `delete_episode`, and related operations;
- prove that each destructive path routes to the caller's group/Falkor graph correctly;
- do not bypass Graphiti with direct FalkorDB queries;
- if the backend lacks enough group context, stop and discuss a minimal backend patch first;
- add cross-agent destructive-isolation tests before exposing the tool.

## Recall/capture controls worth evaluating later

- `captureBackgroundTurns` with default false if OpenClaw exposes a reliable background/subagent distinction.
- custom Graphiti extraction instructions per plugin configuration.
- optional recall result-type controls when real usage shows a need.
- configurable recall failure cooldown.
- explicit connect timeout distinct from request timeout if the MCP transport benefits from it.
- optional diagnostic/test mode that logs IDs and shapes, never secrets/full memory content.
- optional manual force-flush/status operator command if it materially helps debugging.

## Cross-memory defense

- Keep Graphiti-side stripping of `<graphiti-context>`, `<relevant-memories>`, and `<openviking-context>` covered by regression tests.
- After live coexistence testing, inspect whether the installed OpenViking already strips `<graphiti-context>` from capture.
- Modify OpenViking only if a real leakage test demonstrates a gap, and only as a separate discussed change.
- Do not promise semantic isolation from model paraphrases; the invariant is that raw injected blocks are not intentionally fed into the other store.

## Graphiti/Falkor integration follow-ups

- Keep `Graphiti group_id = OpenClaw agentId` as a permanent invariant.
- Retain and regression-test compatibility with the `piqnyx/graphiti` FalkorDB group-isolation fixes.
- Never assume queue acceptance means persistence.
- Consider `custom_extraction_instructions` only after basic episode quality is observed.
- Evaluate Graphiti communities/sagas/advanced graph features only from a concrete use case; do not add maintenance tools to the agent by default.
- Keep backend lifecycle, index maintenance, reset/rebuild, and FalkorDB operations outside this plugin and in existing operational tooling.

## Packaging / project hygiene

- npm only; never introduce pnpm.
- Keep direct-to-`main` small coherent commits unless the owner changes the workflow.
- Keep CI fast and deterministic with no production Graphiti/Falkor credentials.
- Add live integration tests only when they can run against an explicit test backend without touching production data.
- Add release/versioning notes after the first live-tested version is stable.
- Expand README only after runtime behavior is proven, so documentation describes the system we actually have rather than the one we heroically imagined at 3 a.m.