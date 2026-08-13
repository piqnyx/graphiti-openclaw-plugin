# TODO

Roadmap for `graphiti-openclaw-plugin`.

`TECHNICAL_SPEC.md` is authoritative for v0.1. Completed implementation work is removed from this file; Git history already remembers our sins.

## v0.1 — remaining live acceptance

- Pull/build the current `main` on `/home/openclaw/plugins/graphiti-openclaw-plugin` with npm.
- Load the built plugin through the existing OpenClaw plugin load path without changing any exclusive slot.
- Enable the required hook permissions in the existing OpenClaw entry and use `captureBatchTurns=1` for the first proof.
- Verify the plugin loads cleanly and Graphiti MCP connectivity works on the live server.
- Verify one completed turn produces one accepted `add_memory` submission.
- Verify FalkorDB shows the resulting Graphiti entities/facts/relationships.
- Verify same-dialog automatic recall through `<graphiti-context>`.
- Verify another dialog of the same agent recalls information captured in the first dialog.
- Verify another agent cannot recall the first agent's Graphiti memory.
- Verify the model can see both independent OpenViking and Graphiti XML context blocks.
- Verify OpenViking continues working unchanged.
- Verify injected Graphiti/OpenViking blocks are not directly recaptured merely because they were injected into the model prompt.
- Decide from live evidence whether `captureMaxChars` should cap a batch, individual turns, or both. Current v0.1 warns and submits an oversized batch intact rather than silently dropping content.

## Immediately after v0.1 proves the connection

- Decide and implement safe gateway/plugin shutdown flush using the verified OpenClaw lifecycle contract.
- Track Graphiti `queue accepted -> processing -> persisted UUID | failed | timeout` instead of treating queue acceptance as persistence.
- Add bounded retry/backoff behavior for capture failures.
- Add auto-recall failure cooldown so an unhealthy Graphiti endpoint is not hammered every turn.
- Add richer structured diagnostics for queue state, persistence latency, recall latency, result counts, and injected chars.
- Tune recall search strategy and result rendering from real graph data.
- Decide whether separate node/fact limits add value; do not add knobs merely because another plugin had them.
- Evaluate crash-safe local spool/persistence for unsent in-memory batches if gateway restarts become a practical loss mode.

## Agent-visible tools

Add only after auto-capture/auto-recall are proven. Automatic memory flow remains the default, and tool descriptions must discourage unprompted calls.

Planned names:

- `graphiti_recall` — explicitly search Graphiti memory when requested or automatic recall is insufficient.
- `graphiti_store` — explicitly store durable information when requested; derive `group_id` from tool context only.
- `graphiti_forget` — explicitly forget/remove Graphiti information when requested; destructive and strictly agent-scoped.
- `graphiti_status` — inspect plugin/Graphiti connection and recent queue state without exposing secrets.

Permanent rules:

- no tool accepts arbitrary `group_id`;
- every tool resolves identity from `ctx.agentId`;
- tool descriptions say not to call merely because memory exists;
- tools never replace auto-capture/auto-recall.

## Forget/delete safety

Before implementing `graphiti_forget`:

- inspect the then-current `piqnyx/graphiti` MCP schema for `get_entity_edge`, `delete_entity_edge`, `delete_episode`, and related operations;
- prove that every destructive path routes to the caller's Falkor graph/group correctly;
- do not bypass Graphiti with direct FalkorDB queries;
- if the backend lacks enough group context, stop and discuss a minimal backend patch first;
- add cross-agent destructive-isolation tests before exposing the tool.

## Recall/capture controls worth evaluating later

- `captureBackgroundTurns` if OpenClaw exposes a reliable background/subagent distinction worth making configurable.
- custom Graphiti extraction instructions.
- optional recall result-type controls.
- configurable recall failure cooldown.
- explicit connect timeout distinct from request timeout if the MCP transport benefits from it.
- optional diagnostic mode that logs IDs/shapes, never full memory bodies or secrets.
- optional manual force-flush/status operator command if it materially helps debugging.

## Cross-memory defense

- Keep Graphiti-side stripping of `<graphiti-context>`, `<relevant-memories>`, and `<openviking-context>` covered by regression tests.
- During live coexistence testing, confirm whether the installed OpenViking already strips `<graphiti-context>` from its own capture path.
- Modify OpenViking only if a real leakage test demonstrates a gap, and only as a separate discussed change.
- Do not promise semantic isolation from model paraphrases; the invariant is that raw injected blocks are not intentionally fed into the other store.

## Graphiti/Falkor follow-ups

- Keep `Graphiti group_id = OpenClaw agentId` as a permanent invariant.
- Retain compatibility with the `piqnyx/graphiti` FalkorDB group-isolation fixes.
- Never assume queue acceptance means persistence.
- Consider `custom_extraction_instructions` only after basic episode quality is observed.
- Evaluate Graphiti communities/sagas/advanced graph features only from a concrete use case.
- Keep backend lifecycle, reset/rebuild, index maintenance, and FalkorDB operations outside this plugin.

## Packaging / project hygiene

- npm only; never introduce pnpm.
- Keep direct-to-`main` small coherent commits unless the owner changes the workflow.
- Keep CI deterministic with no production Graphiti/Falkor credentials.
- Add live integration tests only against an explicit test backend that cannot touch production data.
- Add release/versioning notes after the first live-tested version is stable.
