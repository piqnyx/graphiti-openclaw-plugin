# graphiti-openclaw-plugin

Slot-less OpenClaw companion plugin for automatic Graphiti/FalkorDB capture and recall with strict per-agent isolation and shared cross-session memory inside each agent.

The plugin connects OpenClaw to an already-running `piqnyx/graphiti` MCP server. It does not own OpenClaw memory/context-engine slots and does not manage Graphiti, FalkorDB, or OpenViking lifecycle.

Authoritative project docs:

- [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md) — current architecture, invariants and the detailed active next phase.
- [`HANDOFF.md`](HANDOFF.md) — full server/repository/operations handoff for the next programmer.
- [`TESTING.md`](TESTING.md) — testing policy and regression invariants.
- [`TODO.md`](TODO.md) — deferred wishlist only, not current work or completed history.
- [`CHANGELOG.md`](CHANGELOG.md) — release/change history.

Historical buffer/JSON design notes were consolidated into `TECHNICAL_SPEC.md` and removed to avoid multiple competing sources of truth.
