# graphiti-openclaw-plugin

Slot-less OpenClaw companion plugin for automatic Graphiti/FalkorDB capture and recall with strict per-agent isolation and shared cross-session memory inside each agent.

The plugin connects OpenClaw to an already-running `piqnyx/graphiti` MCP server. It does not own OpenClaw memory/context-engine slots and does not manage Graphiti, FalkorDB, or OpenViking lifecycle.

Authoritative project docs:

- [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md) — current architecture, invariants, durable capture state and the active phase.
- [`HANDOFF.md`](HANDOFF.md) — full server/repository/operations handoff for the next programmer.
- [`TESTING.md`](TESTING.md) — testing policy and regression invariants.
- [`TODO.md`](TODO.md) — deferred wishlist only, not current work or completed history.
- [`CHANGELOG.md`](CHANGELOG.md) — release/change history.

Historical buffer/JSON design notes were consolidated into `TECHNICAL_SPEC.md` and removed to avoid multiple competing sources of truth.

## Configuration

Every key is documented in `TECHNICAL_SPEC.md`; the deployed example lives in `HANDOFF.md` section 5. Two things worth knowing before the first run:

- `agents` maps an OpenClaw `agentId` to the canonical participant names written into every episode. An agent missing from the map is still captured, under default names, and is reported once in the log.
- `excludeSessionPatterns` is the single source of truth for sessions the plugin ignores in both directions. Entries are regular expressions matched against the session key and the run trigger. Its default reproduces the previously hardcoded cron/heartbeat/subagent/slug-generator filtering, so overriding the list replaces that policy as a whole.
