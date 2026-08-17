import type { GraphitiPluginConfig } from "./config.js";
import { episodeNamePrefix } from "./episode-sequence.js";
import { requireAgentId } from "./identity.js";
import type { GraphitiLogger } from "./logging.js";
import type { GraphitiMcpClient } from "./mcp-client.js";
import { matchSessionExclusion } from "./session-filter.js";
import { sanitizeConversationText } from "./text.js";
import type { PluginToolContext, PluginToolDefinition, PluginToolResult } from "./types.js";

/** Every agent-facing tool carries this prefix so operators can allowlist them as a group. */
export const TOOL_PREFIX = "graphiti_";

export const TOOL_NAMES = [
  "graphiti_recall",
  "graphiti_search_entities",
  "graphiti_context",
  "graphiti_episodes",
  "graphiti_note",
  "graphiti_status",
] as const;

const MAX_NOTE_CHARS = 32_000;
/** How many recent episodes the status tool inspects when checking numbering. */
const CHAIN_CHECK_EPISODES = 100;
/** How many of the most connected entities the status tool names. */
const TOP_ENTITIES = 10;
/** Default and maximum size, in characters, of each side of a context window. */
const DEFAULT_CONTEXT_CHARS = 2_000;
const MAX_CONTEXT_CHARS = 20_000;
/** How many batches either side of the match graphiti_context may fetch. */
const CONTEXT_NEIGHBOURS = 3;

/**
 * Split an episode name into the dialog it belongs to and its batch number.
 *
 * Names are `<saga tail>-<batch number>`; the number is what makes neighbours
 * addressable, since batch n-1 and n+1 are the conversation either side.
 */
export function splitEpisodeName(name: string): { prefix: string; number: number } | undefined {
  const match = /^(.*)-(\d+)$/.exec(name);
  if (!match) return undefined;
  const number = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isInteger(number) || number <= 0) return undefined;
  return { prefix: match[1] ?? "", number };
}

/**
 * Render a stored episode as readable dialogue.
 *
 * Episodes are stored as JSON with the participants' real names alongside the
 * messages; printing that JSON at an agent would be unreadable, and the names are
 * exactly what makes a transcript legible.
 */
export function renderEpisode(episode: Record<string, unknown>): string {
  const name = typeof episode.name === "string" ? episode.name : "";
  const raw = typeof episode.content === "string" ? episode.content : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON: an episode stored by some other path. Show it as it is.
    return raw ? `[${name}]\n${raw}` : "";
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return raw ? `[${name}]\n${raw}` : "";
  const participants = isRecord(parsed.participants) ? parsed.participants : {};
  const speaker = (role: unknown): string => {
    if (role === "user") return text(participants.user) || "User";
    if (role === "assistant") return text(participants.assistant) || "Assistant";
    return text(role) || "Unknown";
  };

  const body = parsed.messages
    .filter(isRecord)
    .map((message) => `${speaker(message.role)}: ${text(message.text)}`.trim())
    .filter((line) => !line.endsWith(":"))
    .join("\n");
  return body ? `[${name}]\n${body}` : "";
}

/**
 * Readers for the graph report.
 *
 * The report is assembled section by section on the server and any section may
 * be missing, so every field is read defensively: a section that failed to run
 * must cost its own line and nothing else.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/**
 * Verify the batch numbering of one saga from episode names alone.
 *
 * The plugin cannot traverse NEXT_EPISODE — MCP exposes no query interface — but
 * every episode is named `<saga tail>-<batch number>`, and the two failures this
 * project has actually suffered both show up there: a duplicated batch appears
 * as a repeated number, a lost one as a gap. Structural edge validation remains
 * the job of the read-only Falkor validator.
 */
export function inspectEpisodeNumbering(
  sessionKey: string,
  episodes: readonly Record<string, unknown>[],
): { seen: number; highest: number; duplicates: number[]; gaps: number[] } {
  const prefix = `${episodeNamePrefix(sessionKey)}-`;
  const numbers: number[] = [];
  for (const episode of episodes) {
    const name = typeof episode.name === "string" ? episode.name : "";
    if (!name.startsWith(prefix)) continue;
    const parsed = Number.parseInt(name.slice(prefix.length), 10);
    if (Number.isInteger(parsed) && parsed > 0) numbers.push(parsed);
  }

  // A dialog with nothing committed yet has no numbering to inspect. Without
  // this the range below runs from 0 to 0 and reports batch 0 as missing, so
  // every brand-new dialog accused itself of having lost a batch.
  if (numbers.length === 0) return { seen: 0, highest: 0, duplicates: [], gaps: [] };

  const counts = new Map<number, number>();
  for (const value of numbers) counts.set(value, (counts.get(value) ?? 0) + 1);
  const highest = numbers.length > 0 ? Math.max(...numbers) : 0;
  const lowest = numbers.length > 0 ? Math.min(...numbers) : 0;
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let value = lowest; value <= highest; value += 1) {
    if (!counts.has(value)) gaps.push(value);
  }
  return { seen: numbers.length, highest, duplicates, gaps };
}
/**
 * The source description of notes written by the old standalone path.
 *
 * Notes are now appended to the conversation, so nothing new carries this. It
 * stays because graphs written before that change still hold such episodes, and
 * they are legitimately saga-less: the status tool must keep counting them
 * separately and must keep telling the server not to report them as detached.
 */
const LEGACY_NOTE_SOURCE_DESCRIPTION = "OpenClaw agent note";

function textResult(text: string, details: Record<string, unknown>): PluginToolResult {
  return { content: [{ type: "text", text }], details };
}

function errorResult(text: string, details: Record<string, unknown>): PluginToolResult {
  return textResult(text, { ...details, ok: false });
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

function limitParam(params: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/** What the local pipeline is holding for one agent right now. */
export type LocalCaptureState = {
  bufferedMessages: number;
  queuedBatches: number;
  /** Age of the least recently touched buffer, or undefined when nothing is buffered. */
  oldestBufferAgeMs?: number;
  spoolPath?: string;
};

export type ToolDependencies = {
  cfg: GraphitiPluginConfig;
  client: GraphitiMcpClient;
  logger: GraphitiLogger;
  excludedSessionPatterns: readonly RegExp[];
  localCaptureState: (agentId: string) => LocalCaptureState;
  /**
   * Append a note to this session's open batch, exactly as a message is appended.
   *
   * The note travels the ordinary capture path instead of being written around
   * it. That is what keeps it attached: it lands in the dialog it was made in,
   * takes its place in that dialog's chain, and cannot fork the chain, because
   * the pipeline that owns the chain is the one doing the writing. Writing an
   * episode directly would leave the pipeline's idea of the last episode stale,
   * and the next batch would point at a predecessor that is no longer last.
   */
  captureNote: (agentId: string, sessionKey: string, note: string) => void;
};

/**
 * Agent-facing Graphiti tools.
 *
 * Every tool resolves the agent from the tool context and passes it as the
 * Graphiti group, so a tool can only ever read or write the calling agent's own
 * graph. A session excluded from memory by `excludeSessionPatterns` cannot use
 * them at all: a session that is not recorded must not query or write memory
 * either.
 *
 * Deliberately absent: anything destructive. The Graphiti MCP delete tools take
 * no group id and run against the driver's default database rather than the
 * agent's graph, so exposing them to an agent could not be made isolation-safe.
 */
export function createGraphitiTools(deps: ToolDependencies): PluginToolDefinition[] {
  const { cfg, client, logger, excludedSessionPatterns, localCaptureState, captureNote } = deps;

  const resolve = (
    toolName: string,
    ctx: PluginToolContext | undefined,
  ): { agentId: string; sessionKey: string } | { refusal: PluginToolResult } => {
    let agentId: string;
    try {
      agentId = requireAgentId(ctx?.agentId);
    } catch (error) {
      logger.warn("tool_refused", {
        tool: toolName,
        reason: "invalid_agent_id",
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        refusal: errorResult(
          "Graphiti memory is unavailable here: this run has no resolvable agent identity.",
          { tool: toolName, reason: "invalid_agent_id" },
        ),
      };
    }

    // Memory belongs to a conversation. A call arriving with no session is not
    // a conversation — it has no dialog to read from and nowhere to write to —
    // so it is refused outright, read-only tools included, rather than quietly
    // answering from, or writing into, a context nobody can point at.
    const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "";
    if (!sessionKey) {
      logger.warn("tool_refused", { tool: toolName, agentId, reason: "no_session" });
      return {
        refusal: errorResult(
          `${toolName} works only inside a conversation, and this run has no session.`,
          { tool: toolName, reason: "no_session" },
        ),
      };
    }

    const excluded = matchSessionExclusion(ctx ?? {}, excludedSessionPatterns);
    if (excluded) {
      logger.debug("tool_refused", {
        tool: toolName,
        agentId,
        sessionKey: ctx?.sessionKey,
        reason: "excluded_session",
        pattern: excluded.pattern,
      });
      return {
        refusal: errorResult(
          `This session is excluded from Graphiti memory by configuration, so ${toolName} did nothing.`,
          { tool: toolName, reason: "excluded_session", pattern: excluded.pattern },
        ),
      };
    }

    return { agentId, sessionKey };
  };

  const failed = (toolName: string, agentId: string, error: unknown): PluginToolResult => {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("tool_failed", { tool: toolName, agentId, group_id: agentId, error: message });
    return errorResult(`Graphiti ${toolName} failed: ${message}`, { tool: toolName, error: message });
  };

  return [
    {
      name: "graphiti_recall",
      label: "Recall facts (Graphiti)",
      description:
        "Search this agent's long-term memory for facts from earlier conversations, including other dialogs. Returns short statements, not raw conversation. " +
        "Relevant memory is injected automatically before each reply, so use this only when that was not enough: the user asks what you remember, or refers to something from another dialog. " +
        "Memory never overrides the current conversation. For the wording of the exchange itself use graphiti_context; if nothing is found here, try the OpenViking search tools.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to look for, in the user's own words. Concrete phrasing recalls better than single keywords.",
          },
          limit: {
            type: "number",
            description: `Maximum facts to return. Default ${cfg.recallLimit}, maximum 50.`,
          },
        },
        required: ["query"],
      },
      async execute(_toolCallId, params, ctx) {
        const resolved = resolve("graphiti_recall", ctx);
        if ("refusal" in resolved) return resolved.refusal;

        const query = sanitizeConversationText(stringParam(params, "query"));
        if (!query) {
          return errorResult("graphiti_recall needs a non-empty query.", {
            tool: "graphiti_recall",
            reason: "empty_query",
          });
        }

        const limit = limitParam(params, "limit", cfg.recallLimit, 50);
        try {
          const facts = await client.searchFacts(query, resolved.agentId, limit);
          const lines = facts
            .map((fact) => (typeof fact.fact === "string" ? sanitizeConversationText(fact.fact) : ""))
            .filter(Boolean);
          logger.info("tool_recall", {
            agentId: resolved.agentId,
            group_id: resolved.agentId,
            results: lines.length,
            limit,
          });
          if (lines.length === 0) {
            return textResult("No matching facts in memory yet.", {
              tool: "graphiti_recall",
              results: 0,
              ok: true,
            });
          }
          return textResult(lines.map((line) => `- ${line}`).join("\n"), {
            tool: "graphiti_recall",
            results: lines.length,
            ok: true,
          });
        } catch (error) {
          return failed("graphiti_recall", resolved.agentId, error);
        }
      },
    },

    {
      name: "graphiti_search_entities",
      label: "Search entities (Graphiti)",
      description:
        "Look up people, places, projects and things this agent knows about, with a short summary of each. " +
        "Use when the question is about who or what something is; for statements and relationships use graphiti_recall. " +
        "If nothing is found here, try the OpenViking search tools.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name or description of the entity to look for." },
          limit: { type: "number", description: "Maximum entities to return. Default 10, maximum 50." },
        },
        required: ["query"],
      },
      async execute(_toolCallId, params, ctx) {
        const resolved = resolve("graphiti_search_entities", ctx);
        if ("refusal" in resolved) return resolved.refusal;

        const query = sanitizeConversationText(stringParam(params, "query"));
        if (!query) {
          return errorResult("graphiti_search_entities needs a non-empty query.", {
            tool: "graphiti_search_entities",
            reason: "empty_query",
          });
        }

        const limit = limitParam(params, "limit", 10, 50);
        try {
          const nodes = await client.searchNodes(query, resolved.agentId, limit);
          const lines = nodes
            .map((node) => {
              const name = typeof node.name === "string" ? sanitizeConversationText(node.name) : "";
              if (!name) return "";
              const summary = typeof node.summary === "string" ? sanitizeConversationText(node.summary) : "";
              return summary ? `- ${name}: ${summary}` : `- ${name}`;
            })
            .filter(Boolean);
          logger.info("tool_search_entities", {
            agentId: resolved.agentId,
            group_id: resolved.agentId,
            results: lines.length,
            limit,
          });
          if (lines.length === 0) {
            return textResult("No matching entities in memory yet.", {
              tool: "graphiti_search_entities",
              results: 0,
              ok: true,
            });
          }
          return textResult(lines.join("\n"), {
            tool: "graphiti_search_entities",
            results: lines.length,
            ok: true,
          });
        } catch (error) {
          return failed("graphiti_search_entities", resolved.agentId, error);
        }
      },
    },

    {
      name: "graphiti_context",
      label: "Read the conversation behind a fact (Graphiti)",
      description:
        "Read the actual conversation a memory came from. graphiti_recall answers what is known; this answers how it was said. " +
        "Give the same query, or an episode name from an earlier call, and how much text to include before and after. " +
        "If the window is too narrow, call again with larger before/after rather than guessing. " +
        "Expensive compared with graphiti_recall — reach for it when wording, tone or the surrounding exchange actually matter.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to find, in the user's words. Ignored when episode is given." },
          episode: { type: "string", description: "Episode name to centre on, e.g. 8248439450-12, as reported by a previous call." },
          before: { type: "number", description: `Characters of conversation before the match. Default ${DEFAULT_CONTEXT_CHARS}, maximum ${MAX_CONTEXT_CHARS}.` },
          after: { type: "number", description: `Characters after the match. Default ${DEFAULT_CONTEXT_CHARS}, maximum ${MAX_CONTEXT_CHARS}.` },
        },
      },
      async execute(_toolCallId, params, ctx) {
        const resolved = resolve("graphiti_context", ctx);
        if ("refusal" in resolved) return resolved.refusal;

        const episodeName = sanitizeConversationText(stringParam(params, "episode")).trim();
        const query = sanitizeConversationText(stringParam(params, "query"));
        if (!episodeName && !query) {
          return errorResult("graphiti_context needs either a query or an episode name.", {
            tool: "graphiti_context",
            reason: "no_anchor",
          });
        }

        const before = limitParam(params, "before", DEFAULT_CONTEXT_CHARS, MAX_CONTEXT_CHARS);
        const after = limitParam(params, "after", DEFAULT_CONTEXT_CHARS, MAX_CONTEXT_CHARS);

        try {
          // Find what to centre on. An episode name is already an anchor; a query
          // has to be resolved through a fact, which carries the uuids of the
          // episodes that produced it.
          let centre: Record<string, unknown> | undefined;
          if (episodeName) {
            centre = (await client.getEpisodesByRef(resolved.agentId, { names: [episodeName] }))[0];
          } else {
            const facts = await client.searchFacts(query, resolved.agentId, 3);
            const sourceUuids = facts
              .flatMap((fact) => (Array.isArray(fact.episodes) ? fact.episodes : []))
              .filter((uuid): uuid is string => typeof uuid === "string")
              .slice(0, 5);
            if (sourceUuids.length === 0) {
              return textResult(
                "Nothing in memory matches that, so there is no conversation to show. Try graphiti_recall for related facts, or the OpenViking search tools.",
                { tool: "graphiti_context", results: 0, ok: true },
              );
            }
            const sources = await client.getEpisodesByRef(resolved.agentId, { uuids: sourceUuids });
            centre = sources[sources.length - 1];
          }

          if (!centre) {
            return textResult("That episode is not in this agent's memory.", {
              tool: "graphiti_context",
              results: 0,
              ok: true,
            });
          }

          const centreName = text(centre.name);
          const position = splitEpisodeName(centreName);
          let window: Record<string, unknown>[] = [centre];
          if (position) {
            // Neighbours are found by batch number: the chain is numbered, so the
            // conversation either side of a batch is simply the batches around it.
            const names: string[] = [];
            for (let step = 1; step <= CONTEXT_NEIGHBOURS; step += 1) {
              names.push(`${position.prefix}-${position.number - step}`);
              names.push(`${position.prefix}-${position.number + step}`);
            }
            const neighbours = await client.getEpisodesByRef(resolved.agentId, {
              names: names.filter((name) => !name.endsWith("-0") && !name.includes("--")),
            });
            window = [...neighbours, centre];
          }

          const ordered = window
            .map((episode) => ({ episode, at: splitEpisodeName(text(episode.name))?.number ?? 0 }))
            .sort((a, b) => a.at - b.at)
            .filter((entry, index, all) => index === 0 || text(entry.episode.name) !== text(all[index - 1]?.episode.name));

          const centreIndex = ordered.findIndex((entry) => text(entry.episode.name) === centreName);
          const rendered = ordered.map((entry) => renderEpisode(entry.episode));
          const head = rendered.slice(0, Math.max(centreIndex, 0)).join("\n");
          const body = rendered[Math.max(centreIndex, 0)] ?? "";
          const tail = rendered.slice(Math.max(centreIndex, 0) + 1).join("\n");

          const transcript = [
            head.length > before ? `…${head.slice(head.length - before)}` : head,
            body,
            tail.length > after ? `${tail.slice(0, after)}…` : tail,
          ]
            .filter(Boolean)
            .join("\n");

          logger.info("tool_context", {
            agentId: resolved.agentId,
            group_id: resolved.agentId,
            episode: centreName,
            episodes: ordered.length,
            chars: transcript.length,
          });

          return textResult(
            `Conversation around ${centreName} (${ordered.length} batch(es)). ` +
              `Call again with episode="${centreName}" and larger before/after for more.\n\n${transcript}`,
            { tool: "graphiti_context", episode: centreName, results: ordered.length, ok: true },
          );
        } catch (error) {
          return failed("graphiti_context", resolved.agentId, error);
        }
      },
    },

    {
      name: "graphiti_episodes",
      label: "Recent episodes (Graphiti)",
      description:
        "List the most recent conversation batches committed to memory, newest first. Use to check whether something was recorded. " +
        "Bookkeeping only: for what was learned use graphiti_recall, to reread an exchange use graphiti_context.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "How many recent episodes to list. Default 10, maximum 50." },
        },
      },
      async execute(_toolCallId, params, ctx) {
        const resolved = resolve("graphiti_episodes", ctx);
        if ("refusal" in resolved) return resolved.refusal;

        const limit = limitParam(params, "limit", 10, 50);
        try {
          const episodes = await client.getEpisodes(resolved.agentId, limit);
          const lines = episodes.map((episode) => {
            const name = typeof episode.name === "string" ? episode.name : "(unnamed)";
            const at = typeof episode.valid_at === "string" ? episode.valid_at
              : typeof episode.created_at === "string" ? episode.created_at
              : "";
            return at ? `- ${name} (${at})` : `- ${name}`;
          });
          logger.info("tool_episodes", {
            agentId: resolved.agentId,
            group_id: resolved.agentId,
            results: lines.length,
            limit,
          });
          if (lines.length === 0) {
            return textResult("No episodes recorded for this agent yet.", {
              tool: "graphiti_episodes",
              results: 0,
              ok: true,
            });
          }
          return textResult(lines.join("\n"), {
            tool: "graphiti_episodes",
            results: lines.length,
            ok: true,
          });
        } catch (error) {
          return failed("graphiti_episodes", resolved.agentId, error);
        }
      },
    },

    {
      name: "graphiti_note",
      label: "Note something to remember (Graphiti)",
      description:
        "Record one lasting fact as a note in this conversation. Two uses: storing something new the user asks you to " +
        "remember (a preference, rule, or fact), and correcting something memory already has wrong. " +
        "The conversation is captured automatically, so do NOT use this for things that were merely said. " +
        "Write the note as a self-contained statement that still makes sense months later, with names spelled out " +
        "rather than pronouns. When correcting, state the correct version AND say plainly what was wrong, in the same " +
        "sentence — that contradiction is what lets memory retire the old fact instead of keeping both. " +
        "It is stored with the surrounding conversation and becomes searchable when that batch is committed.",
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "The fact to remember, as one or a few self-contained sentences.",
          },
          title: {
            type: "string",
            description: "Optional short label, prepended to the note.",
          },
        },
        required: ["note"],
      },
      async execute(_toolCallId, params, ctx) {
        const resolved = resolve("graphiti_note", ctx);
        if ("refusal" in resolved) return resolved.refusal;

        const note = sanitizeConversationText(stringParam(params, "note"));
        if (!note) {
          return errorResult("graphiti_note needs a non-empty note.", {
            tool: "graphiti_note",
            reason: "empty_note",
          });
        }
        if (note.length > MAX_NOTE_CHARS) {
          return errorResult(
            `That note is ${note.length} characters; graphiti_note accepts at most ${MAX_NOTE_CHARS}. Record the essential statement instead of the full text.`,
            { tool: "graphiti_note", reason: "note_too_long", chars: note.length },
          );
        }

        const title = sanitizeConversationText(stringParam(params, "title")).slice(0, 80);
        const body = title ? `${title}: ${note}` : note;

        try {
          // Handed to the capture pipeline as an ordinary message. It leaves with
          // the batch it joined, on the same schedule as the conversation around
          // it — a note is not worth a premature commit, and forcing one would
          // put it in a batch of its own for no gain.
          captureNote(resolved.agentId, resolved.sessionKey, body);
          logger.info("tool_note", {
            agentId: resolved.agentId,
            group_id: resolved.agentId,
            sessionKey: resolved.sessionKey,
            chars: body.length,
          });
          return textResult(
            "Noted. It is part of this conversation now and becomes searchable once the current batch is committed.",
            { tool: "graphiti_note", chars: body.length, ok: true },
          );
        } catch (error) {
          return failed("graphiti_note", resolved.agentId, error);
        }
      },
    },

    {
      name: "graphiti_status",
      label: "Memory status (Graphiti)",
      description:
        "Full diagnostic of this agent's memory: backend health, what is committed and what is still waiting locally, graph size, the most connected entities, and integrity checks for duplicated, missing or orphaned episodes. " +
        "Use when asked whether you are remembering, when memory looks stale, or when the user wants numbers and problems rather than reassurance.",
      parameters: { type: "object", properties: {} },
      async execute(_toolCallId, _params, ctx) {
        const resolved = resolve("graphiti_status", ctx);
        if ("refusal" in resolved) return resolved.refusal;

        const lines: string[] = [];
        // `ok` says whether the tool ran, not whether the graph is spotless.
        // Conflating the two made every finding render as a failed tool call:
        // a diagnostic that reports a defect has done its job, not failed at it.
        const details: Record<string, unknown> = { tool: "graphiti_status", ok: true, healthy: true };
        const problems: string[] = [];
        const flagProblem = (what: string) => {
          problems.push(what);
          details.healthy = false;
          details.problems = problems;
        };
        try {
          const status = await client.getQueueStatus(resolved.agentId);
          details.blocked = status.blocked;
          details.pending = status.pending;
          lines.push(
            status.blocked
              ? `Memory backend is BLOCKED after ${status.attempts} failed attempts: ${status.lastError ?? "unknown error"}. Nothing new is being stored until it recovers.`
              : `Memory backend is healthy. ${status.pending} batch(es) waiting to be processed.`,
          );
        } catch (error) {
          details.backendError = error instanceof Error ? error.message : String(error);
          lines.push(`Memory backend did not answer: ${details.backendError}`);
          flagProblem("backend_unreachable");
        }

        const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "";
        if (sessionKey) {
          try {
            const saga = await client.getSaga(sessionKey, resolved.agentId);
            details.episodeCount = saga?.episodeCount ?? 0;
            lines.push(
              saga
                ? `This dialog has ${saga.episodeCount} episode(s) in memory.`
                : "This dialog has nothing in memory yet; its first batch has not been committed.",
            );
          } catch (error) {
            lines.push(`Could not read this dialog's memory state: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        // What has not left this process yet. Nothing else can report it: the
        // backend cannot see a batch that was never submitted.
        const local = localCaptureState(resolved.agentId);
        details.bufferedMessages = local.bufferedMessages;
        details.queuedBatches = local.queuedBatches;
        const untilFlush = cfg.bufferLimit - local.bufferedMessages;
        lines.push(
          local.bufferedMessages === 0 && local.queuedBatches === 0
            ? "Nothing is waiting locally: everything captured so far has been handed to the backend."
            : `Waiting locally: ${local.bufferedMessages} message(s) in the open batch` +
              (untilFlush > 0 ? ` (${untilFlush} more, or ${Math.round(cfg.bufferTimeout / 60)} min of silence, triggers the next commit)` : "") +
              (local.queuedBatches > 0 ? `, plus ${local.queuedBatches} batch(es) queued for delivery` : "") + ".",
        );

        if (local.oldestBufferAgeMs !== undefined && local.oldestBufferAgeMs > cfg.bufferTimeout * 1000 * 1.5) {
          details.staleBuffer = true;
          lines.push(
            `WARNING: the open batch has been idle for ${Math.round(local.oldestBufferAgeMs / 60000)} min, longer than the ${Math.round(cfg.bufferTimeout / 60)} min timeout. It should have been committed already.`,
          );
        }

        try {
          const episodes = await client.getEpisodes(resolved.agentId, CHAIN_CHECK_EPISODES);
          details.recentEpisodes = episodes.length;

          if (sessionKey) {
            const chain = inspectEpisodeNumbering(sessionKey, episodes);
            details.chain = chain;
            if (chain.duplicates.length > 0) {
              lines.push(
                `PROBLEM: batch number(s) ${chain.duplicates.join(", ")} appear more than once in this dialog. The same messages were committed twice.`,
              );
              flagProblem("duplicate_batches");
            }
            if (chain.gaps.length > 0) {
              lines.push(
                `PROBLEM: batch number(s) ${chain.gaps.join(", ")} are missing from this dialog. Those messages never reached memory.`,
              );
              flagProblem("missing_batches");
            }
            if (chain.seen > 0 && chain.duplicates.length === 0 && chain.gaps.length === 0) {
              lines.push(`Batch numbering is continuous: ${chain.seen} batch(es), 1 through ${chain.highest}, none repeated.`);
            }
            if (typeof details.episodeCount === "number" && details.episodeCount !== chain.seen && chain.seen > 0) {
              lines.push(
                `Note: the saga reports ${details.episodeCount} episode link(s) but ${chain.seen} distinct batch(es) are visible; a mismatch usually means duplicated saga edges.`,
              );
            }
          }

          // Everything below comes from the same window of episodes: shape of the
          // memory, not just its health. Batch size is what tells an operator
          // whether bufferLimit is set sensibly.
          const notes = episodes.filter((e) => e.source_description === LEGACY_NOTE_SOURCE_DESCRIPTION);
          const batches = episodes.filter((e) => e.source_description !== LEGACY_NOTE_SOURCE_DESCRIPTION);
          const dialogs = new Set(
            batches
              .map((e) => (typeof e.name === "string" ? e.name.replace(/-\d+$/, "") : ""))
              .filter(Boolean),
          );
          const sizes = batches
            .map((e) => (typeof e.content === "string" ? e.content.length : 0))
            .filter((size) => size > 0)
            .sort((a, b) => a - b);
          const times = episodes
            .map((e) => (typeof e.created_at === "string" ? Date.parse(e.created_at) : NaN))
            .filter((time) => Number.isFinite(time));

          details.dialogs = dialogs.size;
          details.notes = notes.length;
          if (dialogs.size > 0) {
            lines.push(
              `Across this agent: ${batches.length} committed batch(es) from ${dialogs.size} dialog(s)` +
                (notes.length > 0 ? `, plus ${notes.length} explicit note(s)` : "") + ".",
            );
          }
          if (sizes.length > 0) {
            const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
            details.medianBatchChars = median;
            lines.push(
              `Typical committed batch is ${median} characters (smallest ${sizes[0]}, largest ${sizes[sizes.length - 1]}).`,
            );
          }
          if (times.length > 1) {
            const spanHours = Math.round((Math.max(...times) - Math.min(...times)) / 3_600_000);
            details.spanHours = spanHours;
            lines.push(`Memory in this window spans about ${spanHours} hour(s).`);
          }

          const newest = episodes[0];
          const createdAt = typeof newest?.created_at === "string" ? Date.parse(newest.created_at) : NaN;
          if (Number.isFinite(createdAt)) {
            const ageMin = Math.round((Date.now() - createdAt) / 60000);
            details.newestEpisodeAgeMinutes = ageMin;
            lines.push(`Newest memory across all this agent's dialogs is ${ageMin} min old.`);
          } else if (episodes.length === 0) {
            lines.push("This agent has no episodes at all yet.");
          }
        } catch (error) {
          lines.push(`Could not list recent episodes: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Graph-wide size, shape and integrity. Everything above is derived from
        // episode names and local state; this section is the only one that sees
        // the graph itself, which is where the failures nothing else can detect
        // live — detached episodes, broken chains, facts with no source.
        try {
          // Notes are written without a saga on purpose, so they must not be counted
          // as episodes detached from a dialog: that is the design, not damage.
          const stats = await client.getGraphStats(
            resolved.agentId,
            TOP_ENTITIES,
            LEGACY_NOTE_SOURCE_DESCRIPTION,
          );
          const size = isRecord(stats.size) ? stats.size : {};
          details.graphSize = size;
          lines.push(
            `Graph: ${count(size.entities)} entities, ${count(size.facts)} facts, ` +
              `${count(size.episodes)} episodes, ${count(size.sagas)} dialog(s).`,
          );

          const top = rows(stats.top_entities)
            .map((row) => `${text(row.name)} (${count(row.degree)})`)
            .filter((entry) => !entry.startsWith(" ("));
          if (top.length > 0) lines.push(`Most connected: ${top.join(", ")}.`);

          const oldest = isRecord(stats.oldest_episode) ? text(stats.oldest_episode.created_at) : "";
          const newestAt = isRecord(stats.newest_episode) ? text(stats.newest_episode.created_at) : "";
          if (oldest && newestAt) lines.push(`Memory runs from ${oldest} to ${newestAt}.`);

          const integrity = isRecord(stats.integrity) ? stats.integrity : {};
          details.integrity = integrity;
          const graphProblems: string[] = [];
          for (const row of rows(integrity.duplicate_episode_names)) {
            graphProblems.push(`episode name ${text(row.name)} exists ${count(row.copies)} times`);
          }
          for (const row of rows(integrity.sagas_with_broken_chain)) {
            graphProblems.push(`dialog ${text(row.saga)} has ${count(row.heads)} chain starts, so its NEXT_EPISODE chain is broken`);
          }
          if (count(integrity.episodes_without_saga) > 0) {
            graphProblems.push(`${count(integrity.episodes_without_saga)} episode(s) belong to no dialog`);
          }
          if (count(integrity.facts_without_provenance) > 0) {
            graphProblems.push(`${count(integrity.facts_without_provenance)} fact(s) name no source episode`);
          }
          if (graphProblems.length > 0) {
            flagProblem("graph_integrity");
            lines.push(`PROBLEM: ${graphProblems.join("; ")}.`);
          } else {
            lines.push("Integrity checks passed: no duplicate episode names, no broken chains, no orphaned episodes, every fact has a source.");
          }

          // Not defects, but the numbers that explain a thin or noisy graph.
          const quiet = count(integrity.episodes_without_entities);
          const isolated = count(integrity.isolated_entities);
          if (quiet > 0 || isolated > 0) {
            lines.push(
              `Extraction yield: ${quiet} episode(s) produced no entities, ${isolated} entity(ies) have no relationships.`,
            );
          }

          const queryErrors = rows(stats.query_errors);
          const failedChecks = Array.isArray(stats.query_errors)
            ? stats.query_errors.filter((entry): entry is string => typeof entry === "string")
            : [];
          if (failedChecks.length > 0 || queryErrors.length > 0) {
            lines.push(`Note: ${failedChecks.length || queryErrors.length} graph check(s) could not run: ${failedChecks.join("; ")}`);
          }
        } catch (error) {
          lines.push(`Could not read graph statistics: ${error instanceof Error ? error.message : String(error)}`);
        }

        lines.push(
          `Settings: commit every ${cfg.bufferLimit} messages or after ${Math.round(cfg.bufferTimeout / 60)} min of silence; ` +
            `automatic recall is ${cfg.autoRecall ? `on (up to ${cfg.recallLimit} facts)` : "off"}.`,
        );
        if (!cfg.autoCapture) lines.push("WARNING: automatic capture is switched off, so this dialog is not being recorded.");

        logger.info("tool_status", {
          agentId: resolved.agentId,
          group_id: resolved.agentId,
          blocked: details.blocked,
          pending: details.pending,
          episodeCount: details.episodeCount,
          bufferedMessages: details.bufferedMessages,
          queuedBatches: details.queuedBatches,
          recentEpisodes: details.recentEpisodes,
        });
        return textResult(lines.join("\n"), details);
      },
    },
  ];
}
