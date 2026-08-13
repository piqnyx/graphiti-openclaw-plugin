# TODO

Roadmap for `graphiti-openclaw-plugin`.

`TECHNICAL_SPEC.md` is authoritative for v0.1. Completed implementation work is removed from this file; Git history already remembers our sins.

## v0.1 — remaining live acceptance

- Pull/build the current `main` on `/home/openclaw/plugins/graphiti-openclaw-plugin` with npm.
- Remove stale donor-era Graphiti config keys from the existing OpenClaw entry; do not run `doctor --fix` as a substitute for an intentional edit.
- Keep the plugin slot-less and preserve `plugins.slots.contextEngine = "openviking"` unchanged.
- Keep required hook permissions enabled:
  - `allowPromptInjection=true`
  - `allowConversationAccess=true`
- Use `captureBatchTurns=1` for the first proof.
- Temporarily use plugin diagnostics `logLevel=debug` and `logContent=true`.
- Ensure OpenClaw file logging itself admits debug records during the proof (`logging.level=debug` or an equivalent temporary runtime override); restore normal verbosity afterward.
- Verify the plugin loads cleanly and Graphiti MCP connectivity works on the live server.
- Verify one completed turn produces one accepted `add_memory` submission.
- Inspect debug logs for the exact sanitized `capture_payload` sent to Graphiti.
- Verify FalkorDB shows the resulting Graphiti entities/facts/relationships.
- Verify same-dialog automatic recall through `<graphiti-context>`.
- Inspect debug logs for the exact recall query, returned facts, and final `recall_payload` injected into the model.
- Verify another dialog of the same agent recalls information captured in the first dialog.
- Verify another agent cannot recall the first agent's Graphiti memory.
- Verify the model can see both independent OpenViking and Graphiti XML context blocks.
- Verify OpenViking continues working.
- Verify injected Graphiti/OpenViking blocks are not directly recaptured merely because they were injected into the model prompt.
- After the proof, set `logContent=false` and return OpenClaw file logging to the desired normal level.
- Decide from live evidence whether `captureMaxChars` should cap a batch, individual turns, or both. Current v0.1 warns and submits an oversized batch intact rather than silently dropping content.

## Immediately after v0.1 proves the connection

Priority order should be revisited from live evidence, but these are the expected first follow-ups:

1. **Bounded capture retry/backoff.** Current v0.1 intentionally restores a failed batch and blocks autonomous idle retry until a new turn arrives. Replace that temporary behavior with a bounded policy that cannot hammer Graphiti forever and cannot silently lose retained data.
2. **Persistence tracking.** Track Graphiti `queue accepted -> processing -> persisted UUID | failed | timeout` instead of treating queue acceptance as persistence.
3. **Safe shutdown flush.** Decide and implement gateway/plugin shutdown behavior using the verified OpenClaw lifecycle contract.
4. **OpenViking Graphiti-tag filter patch.** Current `piqnyx/openviking-openclaw-plugin` strips `<relevant-memories>` and `<openviking-context>` but not `<graphiti-context>`. Add the symmetric filter as a separate reviewed OpenViking change, test it, release it, and update the live server.
5. **Byte-aware bounds.** Add explicit UTF-8 byte limits for capture requests and injected recall blocks in addition to or instead of character limits. Define split/drop behavior before enforcing a hard cap.
6. **Recall failure cooldown.** Prevent an unhealthy Graphiti endpoint from being hit on every user turn.
7. **Persistence-safe backlog.** Evaluate a small crash-safe local spool for unsent in-memory batches if gateway restarts prove to be a practical data-loss mode.

## Richer Graphiti episode information

The Graphiti MCP `add_memory` surface exposes substantially more than the minimal v0.1 request. After the basic graph is proven, inspect which fields OpenClaw genuinely knows and forward useful provenance rather than inventing it.

Candidates include:

- `reference_time` when a trustworthy event/message time exists;
- `previous_episode_uuids` for explicit continuity between batches;
- `custom_extraction_instructions` when a concrete extraction-quality issue exists;
- `excluded_entity_types` only for a demonstrated need;
- `saga` / `saga_previous_episode_uuid` if they improve long-running conversational continuity;
- `update_communities` only after its cost and usefulness are measured.

Do not add every parameter simply because the API has one. Each field needs a source, semantics, and a test.

## Cross-batch continuity / broader context experiments

Graphiti may benefit from more continuity than one isolated batch at a time. Research this after the minimal path works.

Preferred experiment order:

1. Try Graphiti-native continuity such as `previous_episode_uuids` and/or sagas before duplicating raw history.
2. Measure whether links across consecutive batches improve without replay.
3. If needed, test a bounded overlap window: include the last N previously submitted turns/batches as context while making it explicit which content is new.
4. Only if evidence supports it, test a periodic larger synthesis/overview episode that summarizes a broader recent window and may connect facts spread across many batches.

Any replay/overlap design must avoid turning old content into duplicate episodes or creating misleading temporal facts merely to force more graph edges.

## Recall quality and observability

- Tune search strategy and result rendering from real graph data.
- Decide whether facts alone are sufficient or node + fact recall improves useful context.
- Decide whether separate node/fact limits add value; do not resurrect donor knobs by habit.
- Add richer structured diagnostics for queue state, persistence latency, recall latency, result counts, injected chars/bytes, and retry state.
- Consider an operator-only status/force-flush command if it materially improves debugging.
- Keep raw content logging explicitly opt-in; never make it an accidental permanent production default.

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

Deletion is a separate design exercise. Do not guess it from the write/search path.

Before implementing `graphiti_forget`:

- inspect the then-current `piqnyx/graphiti` MCP schema for retrieval/deletion operations such as `get_entity_edge`, `delete_entity_edge`, `delete_episode`, and related APIs;
- determine exactly which objects are deleted by UUID and what provenance/cascade semantics Graphiti applies;
- decide whether recall/search is the correct way to discover candidate UUIDs or whether a more precise lookup is required;
- prove that every destructive path routes to the caller's Falkor graph/group correctly;
- do not bypass Graphiti with direct FalkorDB queries;
- if the backend lacks enough group context, stop and discuss a minimal backend patch first;
- add cross-agent destructive-isolation tests before exposing the tool;
- require an explicit user/agent intent for destructive operations.

## Recall/capture controls worth evaluating later

- `captureBackgroundTurns` if OpenClaw exposes a reliable background/subagent distinction worth making configurable.
- custom Graphiti extraction instructions.
- optional recall result-type controls.
- configurable recall failure cooldown.
- explicit connect timeout distinct from request timeout if the MCP transport benefits from it.
- optional diagnostic/test mode enhancements that never expose secrets by default.
- configurable capture/injection byte budgets with explicit split behavior.

## Cross-memory defense

- Keep Graphiti-side stripping of `<graphiti-context>`, `<relevant-memories>`, and `<openviking-context>` covered by regression tests.
- Treat the missing `<graphiti-context>` filter in the current OpenViking fork as a known deferred issue, not an unknown.
- Patch OpenViking separately after the first Graphiti live proof and add the reciprocal regression test there.
- Do not promise semantic isolation from model paraphrases; the invariant is that raw injected blocks are not intentionally fed into the other store.

## Graphiti/Falkor follow-ups

- Keep `Graphiti group_id = OpenClaw agentId` as a permanent invariant.
- Retain compatibility with the `piqnyx/graphiti` FalkorDB group-isolation fixes.
- Never assume queue acceptance means persistence.
- Evaluate Graphiti communities/sagas/advanced graph features only from a concrete use case and measured cost.
- Keep backend lifecycle, reset/rebuild, index maintenance, and FalkorDB operations outside this plugin.
- Review other mature memory plugins for useful mechanics only after our invariants are fixed; borrow ideas, not accidental architecture.

## Testing / project hygiene

- Follow `TESTING.md`; tests must catch behavior and failure regressions, not decorate CI.
- npm only; never introduce pnpm.
- Keep direct-to-`main` small coherent commits unless the owner changes the workflow.
- Keep CI deterministic with no production Graphiti/Falkor credentials.
- Add live integration tests only against an explicit disposable backend that cannot touch production data.
- Add release/versioning notes after the first live-tested version is stable.
- Treat dependency-lock problems as real reproducibility issues, not cosmetic noise. If `package-lock.json` cannot be updated automatically, stop and resolve it explicitly rather than hand-waving it away.
