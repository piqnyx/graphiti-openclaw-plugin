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

**Delivery.** Graphiti answers "queued" as soon as it takes a batch and extracts entities afterwards, so acceptance is not storage: when extraction fails — an unreachable model, a truncated reply — nothing reports it and the episode never appears. A batch therefore stays on a durable ledger until its episode is found in the graph, and is resent until it is. Retries are unbounded with a wait doubling from 30 seconds to an hour, because the failure this survives is a backend that returns in hours and giving up would lose exactly what waiting saves. Resending is safe because the episode uuid is derived from the batch content and the server merges on it. The ledger is bounded by size (50 GB by default), and both what is waiting and anything dropped for space are reported by `graphiti_status`.

Batch numbers are never reused. After a restart the sequence resumes from the larger of what the backend has processed and what this process already issued: the backend's count lags acceptance, and trusting it alone once gave one dialog two different episodes with the same name.

**Recall.** Before each reply the plugin searches the agent's memory with the current prompt plus a bounded slice of recent conversation, and prepends the results as a `<graphiti-context>` block. Injected memory is explicitly marked as memory, not instructions.

**Tools.** Agents can also query and write memory on demand — see below.

The isolation rule behind all of it: `OpenClaw agentId` → Graphiti `group_id` → physical FalkorDB graph. One agent can never read or write another agent's memory. Within one agent there is deliberately no isolation between dialogs: something learned in one conversation is recalled in another.

## Agent tools

Enabled by `agentTools` (default true) and registered only if the host exposes a tool API. Which agent may call which tool is governed by the OpenClaw per-agent tool allowlist, so add the ones you want to that agent's `tools.alsoAllow`.

| Tool | What it does | When the agent should reach for it |
|---|---|---|
| `graphiti_search` | Searches memory for facts, entities and episodes at once, each scored, each with episode anchors | Automatic recall was not enough: the user asks what you remember, or refers to another dialog |
| `graphiti_browse` | Reads the conversation behind one or more anchors | The wording, tone or surrounding exchange matters, not just the fact |
| `graphiti_note` | Records one lasting fact into the conversation | The user explicitly asks to remember something lasting |
| `graphiti_status` | Reports backend health, graph size and integrity checks | Memory looks stale or empty and the agent needs to say why |

`graphiti_search` and `graphiti_browse` are two steps of one move: the first answers what is known, the second shows how it was said.

Every hit carries the reranker's score and a list of episode anchors such as `8248439450-12`, each with a count of how many results point at it — the higher the count, the more of the answer lives in that episode. Those anchors are what `graphiti_browse` takes, several at a time, including anchors from different hits. Episodes are a result type in their own right, matched on the words of the conversation itself, so a query can reach the dialog without going through a fact at all.

Facts superseded by newer ones are hidden unless `include_outdated` asks for them, so an answer reflects what memory currently holds true. Per-type limits (`facts`, `entities`, `episodes`) let the agent ask for only what it needs; zero excludes a type.

Two time filters answer two different questions and are deliberately not merged. `discussed_within_days` bounds when something was recorded — "what did we go over last week". `valid_from` and `valid_to` bound when a fact was true — "where did he live in 2024". Using one for the other gives a confidently wrong answer.

`graphiti_search` points at the OpenViking tools when it finds nothing, and the OpenViking search tools point back here, so a blank in one store is not mistaken for a blank in memory.

Every tool resolves the agent from its invocation context and passes it as the Graphiti group, so a tool call cannot cross into another agent's graph. A session matched by `excludeSessionPatterns` cannot use the tools at all: a session that is not recorded must not query or write memory either.

`graphiti_note` appends the note to the open batch of the conversation it was made in, exactly as a message is appended, and it leaves with that batch on the ordinary schedule. This is what keeps a note attached: it belongs to a dialog, sits in that dialog's chain, and is searchable once the batch is committed.

Writing the episode directly instead would fork the chain. A saga is the chronology of one dialog and the capture pipeline owns it, holding the last episode of the chain in memory; an episode written around the pipeline would leave that memory stale, and the next batch would point at a predecessor that is no longer last. Letting the pipeline do the writing removes the race rather than timing around it.

Every tool, read-only ones included, refuses a run with no session: memory belongs to a conversation, and a call from outside one has no dialog to read from and nowhere to write to.

There is deliberately no destructive tool. The Graphiti MCP delete endpoints take no group id and run against the driver's default database rather than the agent's graph, so exposing them to an agent could not be made isolation-safe. See `TODO.md` for what would have to be true first.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8000/mcp/` | Graphiti MCP endpoint |
| `autoCapture` | `true` | Record conversations into memory |
| `autoRecall` | `true` | Inject relevant memory before each reply |
| `agentTools` | `true` | Register the `graphiti_*` tools |
| `agents` | `{main: …}` | Maps `agentId` to the canonical participant names written into every episode. An unlisted agent is still captured, under default names, and is reported once in the log |
| `excludeSessionPatterns` | cron/heartbeat/subagent/slug/setup probes | Regular expressions tested against the session key **and** the run trigger. A match excludes the session from capture, recall and tools alike. Overriding the list replaces the whole policy |
| `bufferLimit` | `4` | Messages per batch. Larger batches extract richer entities and call the LLM less often; the ceiling is what your Graphiti LLM backend digests reliably |
| `bufferTimeout` | `900` | Seconds of silence after which a partial batch is committed anyway. Minimum 30 |
| `requestTimeoutMs` | `45000` | MCP request timeout, also the budget for the recall hook |
| `recallLimit` | `8` | Maximum facts retrieved per recall |
| `recallQueryMaxChars` | `6000` | Character budget for the whole recall query |
| `recallMaxInjectedChars` | `8000` | Character budget for the injected `<graphiti-context>` block |
| `recallUseHistory` | `true` | Enrich the recall query with recent conversation |
| `recallHistoryMaxMessages` | `6` | Messages of history used for that enrichment |
| `recallHistoryMaxChars` | `4000` | Character budget for the history portion |
| `browseChars` | `16000` | Characters `graphiti_browse` reads on each side of an anchor by default |
| `browseMaxChars` | `32000` | Ceiling on `before`/`after` in one call |
| `browseMaxEpisodes` | `10` | How many anchors one call will expand |
| `browseMaxTotalChars` | `120000` | Size of one browse reply. What does not fit is reported as omitted, never dropped silently |
| `logOperations` | `true` | Emit operational info/debug events |
| `logLevel` | `info` | `error`, `warn`, `info` or `debug` |
| `logContent` | `false` | Also log message bodies and payloads. Diagnostics only: it writes conversations to the journal |

An unknown key, an invalid regular expression or an out-of-range number fails the plugin at load rather than silently degrading.
