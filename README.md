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

## How it works

Two automatic paths and one manual one.

**Capture.** After every agent run the plugin diffs the transcript, keeps only new `user`/`assistant` messages, and buffers them per dialog. A batch is submitted to Graphiti when it reaches `bufferLimit` messages or the dialog goes quiet for `bufferTimeout` seconds. Each dialog becomes one Graphiti saga; each batch becomes one episode in it, chained to its predecessor. Unsent batches survive a gateway restart in a durable spool.

**Recall.** Before each reply the plugin searches the agent's memory with the current prompt plus a bounded slice of recent conversation, and prepends the results as a `<graphiti-context>` block. Injected memory is explicitly marked as memory, not instructions.

**Tools.** Agents can also query and write memory on demand — see below.

The isolation rule behind all of it: `OpenClaw agentId` → Graphiti `group_id` → physical FalkorDB graph. One agent can never read or write another agent's memory. Within one agent there is deliberately no isolation between dialogs: something learned in one conversation is recalled in another.

## Agent tools

Enabled by `agentTools` (default true) and registered only if the host exposes a tool API. Which agent may call which tool is governed by the OpenClaw per-agent tool allowlist, so add the ones you want to that agent's `tools.alsoAllow`.

| Tool | What it does | When the agent should reach for it |
|---|---|---|
| `graphiti_recall` | Searches the agent's memory for facts | Automatic recall was not enough: the user asks what you remember, or refers to another dialog |
| `graphiti_search_entities` | Searches known people, places, projects | The question is about an entity rather than a statement |
| `graphiti_episodes` | Lists recently committed conversation batches | Checking what has actually reached memory |
| `graphiti_store` | Writes one durable note | The user explicitly asks to remember something lasting |
| `graphiti_status` | Reports backend health and this dialog's episode count | Memory looks stale or empty and the agent needs to say why |

Every tool resolves the agent from its invocation context and passes it as the Graphiti group, so a tool call cannot cross into another agent's graph. A session matched by `excludeSessionPatterns` cannot use the tools at all: a session that is not recorded must not query or write memory either.

`graphiti_store` writes a standalone episode with no saga. A saga is the chronology of one dialog, maintained batch by batch by the capture pipeline; injecting a note into that chain would fork its predecessor links.

There is deliberately no destructive tool. The Graphiti MCP delete endpoints take no group id and run against the driver's default database rather than the agent's graph, so exposing them to an agent could not be made isolation-safe. See `TODO.md` for what would have to be true first.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8000/mcp/` | Graphiti MCP endpoint |
| `autoCapture` | `true` | Record conversations into memory |
| `autoRecall` | `true` | Inject relevant memory before each reply |
| `agentTools` | `true` | Register the `graphiti_*` tools |
| `agents` | `{main: …}` | Maps `agentId` to the canonical participant names written into every episode. An unlisted agent is still captured, under default names, and is reported once in the log |
| `excludeSessionPatterns` | cron/heartbeat/subagent/slug | Regular expressions tested against the session key **and** the run trigger. A match excludes the session from capture, recall and tools alike. Overriding the list replaces the whole policy |
| `bufferLimit` | `4` | Messages per batch. Larger batches extract richer entities and call the LLM less often; the ceiling is what your Graphiti LLM backend digests reliably |
| `bufferTimeout` | `900` | Seconds of silence after which a partial batch is committed anyway. Minimum 30 |
| `requestTimeoutMs` | `45000` | MCP request timeout, also the budget for the recall hook |
| `recallLimit` | `8` | Maximum facts retrieved per recall |
| `recallQueryMaxChars` | `6000` | Character budget for the whole recall query |
| `recallMaxInjectedChars` | `8000` | Character budget for the injected `<graphiti-context>` block |
| `recallUseHistory` | `true` | Enrich the recall query with recent conversation |
| `recallHistoryMaxMessages` | `6` | Messages of history used for that enrichment |
| `recallHistoryMaxChars` | `4000` | Character budget for the history portion |
| `logOperations` | `true` | Emit operational info/debug events |
| `logLevel` | `info` | `error`, `warn`, `info` or `debug` |
| `logContent` | `false` | Also log message bodies and payloads. Diagnostics only: it writes conversations to the journal |

An unknown key, an invalid regular expression or an out-of-range number fails the plugin at load rather than silently degrading.
