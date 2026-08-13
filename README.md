# graphiti-openclaw-plugin

Slot-less OpenClaw companion plugin for automatic Graphiti/FalkorDB capture and recall with strict per-agent isolation.

The plugin connects OpenClaw to an already-running Graphiti MCP server. It does not own the OpenClaw memory/context-engine slots and does not manage Graphiti, FalkorDB, or OpenViking lifecycle.

Current work is the minimal v0.1 live vertical slice. See:

- [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md) — authoritative active specification.
- [`TODO.md`](TODO.md) — implementation roadmap and deferred features.

Development uses npm and direct small commits to `main`.
