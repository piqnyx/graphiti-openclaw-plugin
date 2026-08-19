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
  "graphiti_search",
  "graphiti_browse",
  "graphiti_note",
  "graphiti_status",
] as const;

const MAX_NOTE_CHARS = 32_000;
/** Per-type result limits for graphiti_search; zero excludes a type entirely. */
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
/** How many episode anchors accompany each hit. */
const DEFAULT_ANCHORS = 10;
const MAX_ANCHORS = 25;
/** How many recent episodes the status tool inspects when checking numbering. */
const CHAIN_CHECK_EPISODES = 100;
/** How many of the most connected entities the status tool names. */
const TOP_ENTITIES = 10;
/** Default and maximum size, in characters, of each side of a context window. */
const DEFAULT_CONTEXT_CHARS = 2_000;
const MAX_CONTEXT_CHARS = 20_000;
/** How many batches either side of an anchor graphiti_browse reads. */
const BROWSE_NEIGHBOURS = 3;

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
    // Strictly digits after the prefix. parseInt stops at the first non-digit,
    // so it read "22-orphan" — an episode deliberately renamed out of the
    // numbering — as batch 22, and reported the dialog as having committed 22
    // twice. A name that is not `<prefix>-<number>` is not part of the sequence.
    const suffix = name.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    const parsed = Number.parseInt(suffix, 10);
    if (parsed > 0) numbers.push(parsed);
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

/** "3 hours" — a duration a person reads without converting anything. */
function describeDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hour(s)` : `${Math.round(hours / 24)} day(s)`;
}

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

/** Like limitParam, but zero is a legitimate answer: it means "none of this type". */
function countParam(params: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Two decimals: the agent compares these numbers, it does not do arithmetic on them. */
function formatScore(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "?";
}

/**
 * Map episode uuids to their names.
 *
 * Facts carry uuids, and a uuid is useless to an agent: it cannot be typed back
 * into graphiti_browse, and it says nothing about which dialog or when. Names
 * carry both. One lookup covers the whole result set.
 */
async function resolveEpisodeNames(
  client: GraphitiMcpClient,
  agentId: string,
  uuids: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (uuids.length === 0) return names;
  const episodes = await client.getEpisodesByRef(agentId, { uuids: [...uuids] });
  for (const episode of episodes) {
    const uuid = typeof episode.uuid === "string" ? episode.uuid : "";
    const name = typeof episode.name === "string" ? episode.name : "";
    if (uuid && name) names.set(uuid, name);
  }
  return names;
}

/**
 * Render one episode with the conversation around it.
 *
 * Neighbours are found by batch number rather than by timestamp: the chain is
 * numbered, so the exchange either side of a batch is simply the batches next to
 * it, and that holds even when several dialogs were recorded in the same minute.
 */
async function readAround(
  client: GraphitiMcpClient,
  agentId: string,
  anchor: string,
  before: number,
  after: number,
): Promise<string> {
  const centre = (await client.getEpisodesByRef(agentId, { names: [anchor] }))[0];
  if (!centre) return "";

  const centreName = typeof centre.name === "string" ? centre.name : anchor;
  const position = splitEpisodeName(centreName);
  let window: Record<string, unknown>[] = [centre];
  if (position) {
    const names: string[] = [];
    for (let step = 1; step <= BROWSE_NEIGHBOURS; step += 1) {
      if (position.number - step > 0) names.push(`${position.prefix}-${position.number - step}`);
      names.push(`${position.prefix}-${position.number + step}`);
    }
    const neighbours = await client.getEpisodesByRef(agentId, { names });
    window = [...neighbours, centre];
  }

  const ordered = window
    .map((episode) => ({ episode, at: splitEpisodeName(typeof episode.name === "string" ? episode.name : "")?.number ?? 0 }))
    .sort((a, b) => a.at - b.at)
    .filter((entry, index, all) => index === 0 || entry.episode.name !== all[index - 1]?.episode.name);

  const centreIndex = Math.max(ordered.findIndex((entry) => entry.episode.name === centreName), 0);
  const rendered = ordered.map((entry) => renderEpisode(entry.episode));
  const head = rendered.slice(0, centreIndex).join("\n");
  const body = rendered[centreIndex] ?? "";
  const tail = rendered.slice(centreIndex + 1).join("\n");

  const transcript = [
    head.length > before ? `…${head.slice(head.length - before)}` : head,
    body,
    tail.length > after ? `${tail.slice(0, after)}…` : tail,
  ]
    .filter(Boolean)
    .join("\n");
  return transcript ? `── ${centreName} ──\n${transcript}` : "";
}

function limitParam(params: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/** What the local pipeline is holding for one agent right now. */
export type LocalCaptureState = {
  bufferedMessages: number;
  /**
   * Where capture reads the conversation from, and whether it can.
   *
   * Capture is a read of the gateway's own transcript store, so "is the store
   * readable and does it still look the way we read it" is the first question
   * when the graph stops growing. Reported here so a scheduled status check can
   * answer it without anyone opening a log.
   */
  storePath?: string;
  storeReadable?: boolean;
  queuedBatches: number;
  /** Age of the least recently touched buffer, or undefined when nothing is buffered. */
  oldestBufferAgeMs?: number;
  spoolPath?: string;
  /**
   * Batches Graphiti accepted but has not yet been seen to store.
   *
   * The backend reports its own queue, and that queue empties whether or not the
   * work succeeded — so a batch lost to a failed extraction shows up nowhere on
   * the server side. This is the only place that difference is visible, which is
   * why it belongs in a status the user can simply ask for.
   */
  awaitingConfirmation: number;
  oldestAwaitingMs?: number;
  awaitingBytes: number;
  /** Batches retried enough times to be worth mentioning; they are still retried. */
  notLanding: { name: string; attempts: number; ageMs: number }[];
  /** Batches given up only because the ledger hit its size bound. */
  droppedForSpace: number;
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
      name: "graphiti_search",
      label: "Search memory (Graphiti)",
      description:
        "Search this agent's memory across all its dialogs. Three kinds of hit, each with a score: " +
        "[fact] what is known, in the extractor's words rather than quoted; [entity] a person, place or project; " +
        "[episode] a piece of conversation that matched. " +
        "Each hit lists episode anchors like 8248439450-12; the number beside one is how many hits point at it, so the biggest number is where the answer lives. " +
        "Pass anchors to graphiti_browse to read what was actually said. " +
        "Memory is injected automatically before each reply — search when that was not enough. Found nothing? Try the OpenViking search tools.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to look for, in the user's words. A phrase matches better than one keyword.",
          },
          facts: { type: "number", description: `How many facts to return. Default ${DEFAULT_SEARCH_LIMIT}, 0 to skip them, maximum ${MAX_SEARCH_LIMIT}.` },
          entities: { type: "number", description: `How many entities to return. Default ${DEFAULT_SEARCH_LIMIT}, 0 to skip them, maximum ${MAX_SEARCH_LIMIT}.` },
          episodes: { type: "number", description: `How many episodes to return. Default ${DEFAULT_SEARCH_LIMIT}, 0 to skip them, maximum ${MAX_SEARCH_LIMIT}.` },
          anchors: { type: "number", description: `Anchors shown per hit. Default ${DEFAULT_ANCHORS}, maximum ${MAX_ANCHORS}.` },
          discussed_within_days: { type: "number", description: "Only what was recorded in the last N days: when it was discussed, not when it was true." },
          valid_from: { type: "string", description: "ISO date. Only facts that were true at or after this point." },
          valid_to: { type: "string", description: "ISO date. Only facts that were true at or before this point." },
          include_outdated: { type: "boolean", description: "Also return facts a later one replaced, marked [outdated]. Off by default." },
        },
        required: ["query"],
      },
      async execute(_toolCallId, params, ctx) {
        const resolved = resolve("graphiti_search", ctx);
        if ("refusal" in resolved) return resolved.refusal;

        const query = sanitizeConversationText(stringParam(params, "query"));
        if (!query) {
          return errorResult("graphiti_search needs a non-empty query.", {
            tool: "graphiti_search",
            reason: "empty_query",
          });
        }

        const wanted = {
          facts: countParam(params, "facts", DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT),
          entities: countParam(params, "entities", DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT),
          episodes: countParam(params, "episodes", DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT),
        };
        if (wanted.facts + wanted.entities + wanted.episodes === 0) {
          return errorResult("graphiti_search was asked for nothing: set at least one of facts, entities or episodes above zero.", {
            tool: "graphiti_search",
            reason: "nothing_requested",
          });
        }
        const anchorLimit = limitParam(params, "anchors", DEFAULT_ANCHORS, MAX_ANCHORS);
        const includeOutdated = params.include_outdated === true;

        const days = countParam(params, "discussed_within_days", 0, 3_650);
        const filters = {
          ...(days > 0 ? { createdAtAfter: new Date(Date.now() - days * 86_400_000).toISOString() } : {}),
          ...(stringParam(params, "valid_from") ? { validAtAfter: stringParam(params, "valid_from") } : {}),
          ...(stringParam(params, "valid_to") ? { validAtBefore: stringParam(params, "valid_to") } : {}),
        };

        try {
          // One request covers every type; the per-type limits are applied here,
          // because the server takes a single limit and a caller asking for ten
          // facts and no entities must not be charged a second round trip.
          const raw = await client.searchCombined(
            query,
            resolved.agentId,
            Math.max(wanted.facts, wanted.entities, wanted.episodes),
            filters,
          );

          const facts = raw.facts
            .filter((fact) => includeOutdated || !text(fact.invalid_at))
            .slice(0, wanted.facts);
          const entities = raw.entities.slice(0, wanted.entities);
          const episodes = raw.episodes.slice(0, wanted.episodes);

          if (facts.length + entities.length + episodes.length === 0) {
            return textResult("Nothing in memory matches that. The OpenViking search tools cover material this graph does not.", {
              tool: "graphiti_search",
              results: 0,
              ok: true,
            });
          }

          // Anchors are episode names, and the count beside each one says how many
          // of these results point at it: a number the agent can act on without
          // knowing anything about provenance.
          const uuidCounts = new Map<string, number>();
          for (const fact of facts) {
            for (const uuid of asStrings(fact.episodes)) {
              uuidCounts.set(uuid, (uuidCounts.get(uuid) ?? 0) + 1);
            }
          }
          const names = await resolveEpisodeNames(client, resolved.agentId, [
            ...uuidCounts.keys(),
          ]);

          const anchorsFor = (uuids: string[]): string => {
            const seen = new Map<string, number>();
            for (const uuid of uuids) {
              const name = names.get(uuid);
              if (!name) continue;
              seen.set(name, Math.max(seen.get(name) ?? 0, uuidCounts.get(uuid) ?? 1));
            }
            const ordered = [...seen.entries()]
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .slice(0, anchorLimit);
            return ordered.length > 0
              ? `\n  episodes: ${ordered.map(([name, hits]) => `${name} ×${hits}`).join(", ")}`
              : "";
          };

          // An entity has no episodes of its own; the facts touching it do.
          const entityAnchors = (uuid: string): string[] =>
            facts
              .filter((fact) => text(fact.source_node_uuid) === uuid || text(fact.target_node_uuid) === uuid)
              .flatMap((fact) => asStrings(fact.episodes));

          const lines: string[] = [];
          for (const fact of facts) {
            const outdated = text(fact.invalid_at) ? " [outdated]" : "";
            lines.push(
              `[fact ${formatScore(fact.score)}]${outdated} ${sanitizeConversationText(text(fact.fact))}` +
                anchorsFor(asStrings(fact.episodes)),
            );
          }
          for (const entity of entities) {
            const summary = sanitizeConversationText(text(entity.summary));
            lines.push(
              `[entity ${formatScore(entity.score)}] ${text(entity.name)}${summary ? ` — ${summary}` : ""}` +
                anchorsFor(entityAnchors(text(entity.uuid))),
            );
          }
          for (const episode of episodes) {
            lines.push(`[episode ${formatScore(episode.score)}] ${text(episode.name)}`);
          }

          logger.info("tool_search", {
            agentId: resolved.agentId,
            group_id: resolved.agentId,
            facts: facts.length,
            entities: entities.length,
            episodes: episodes.length,
          });
          return textResult(lines.join("\n"), {
            tool: "graphiti_search",
            facts: facts.length,
            entities: entities.length,
            episodes: episodes.length,
            ok: true,
          });
        } catch (error) {
          return failed("graphiti_search", resolved.agentId, error);
        }
      },
    },

    {
      name: "graphiti_browse",
      label: "Read the conversation behind a hit (Graphiti)",
      description:
        "Read what was actually said, in the dialog it was said in. graphiti_search gives the anchors; this reads around them — pass several at once, from different hits if you like. " +
        "Cut off mid-thought? Call again with bigger before/after. " +
        "Costlier than searching: use it when the exact wording, tone or surrounding exchange matters.",
      parameters: {
        type: "object",
        properties: {
          episodes: {
            type: "array",
            items: { type: "string" },
            description: "Episode names from a search, such as 8248439450-12. Several may be given.",
          },
          episode: { type: "string", description: "A single anchor, if you have only one." },
          query: { type: "string", description: "Used only when no anchors are given: finds the conversation behind the best match." },
          before: { type: "number", description: `Characters of conversation before each anchor. Default ${cfg.browseChars}, maximum ${cfg.browseMaxChars}.` },
          after: { type: "number", description: `Characters after each anchor. Default ${cfg.browseChars}, maximum ${cfg.browseMaxChars}.` },
        },
      },
      async execute(_toolCallId, params, ctx) {
        const resolved = resolve("graphiti_browse", ctx);
        if ("refusal" in resolved) return resolved.refusal;

        const asked = Array.isArray(params.episodes)
          ? params.episodes.filter((name): name is string => typeof name === "string").map((name) => name.trim()).filter(Boolean)
          : [];
        const single = sanitizeConversationText(stringParam(params, "episode")).trim();
        const requested = [...new Set(single ? [...asked, single] : asked)].slice(0, cfg.browseMaxEpisodes);
        const query = sanitizeConversationText(stringParam(params, "query"));
        if (requested.length === 0 && !query) {
          return errorResult("graphiti_browse needs either episode names or a query.", {
            tool: "graphiti_browse",
            reason: "no_anchor",
          });
        }

        const before = limitParam(params, "before", cfg.browseChars, cfg.browseMaxChars);
        const after = limitParam(params, "after", cfg.browseChars, cfg.browseMaxChars);

        try {
          let anchors = requested;
          if (anchors.length === 0) {
            // No anchor given: find one the same way a search would, then read
            // around it. The episode types of a combined search already are
            // anchors, so a direct hit needs no fact to go through.
            const found = await client.searchCombined(query, resolved.agentId, 3);
            const viaEpisode = found.episodes.map((episode) => text(episode.name)).filter(Boolean);
            const viaFacts = found.facts.flatMap((fact) => asStrings(fact.episodes));
            const names = viaEpisode.length > 0
              ? viaEpisode
              : [...(await resolveEpisodeNames(client, resolved.agentId, viaFacts)).values()];
            anchors = [...new Set(names)].slice(0, cfg.browseMaxEpisodes);
          }

          if (anchors.length === 0) {
            return textResult(
              "Nothing in memory matches that, so there is no conversation to show. Try graphiti_search, or the OpenViking search tools.",
              { tool: "graphiti_browse", results: 0, ok: true },
            );
          }

          const sections: string[] = [];
          let budget = cfg.browseMaxTotalChars;
          let shown = 0;
          for (const anchor of anchors) {
            if (budget <= 0) break;
            const section = await readAround(client, resolved.agentId, anchor, before, after);
            if (!section) continue;
            const trimmed = section.length > budget ? `${section.slice(0, budget)}…` : section;
            budget -= trimmed.length;
            shown += 1;
            sections.push(trimmed);
          }

          if (sections.length === 0) {
            return textResult("None of those episodes are in this agent's memory.", {
              tool: "graphiti_browse",
              results: 0,
              ok: true,
            });
          }

          const truncated = shown < anchors.length;
          logger.info("tool_browse", {
            agentId: resolved.agentId,
            group_id: resolved.agentId,
            requested: anchors.length,
            shown,
            chars: cfg.browseMaxTotalChars - budget,
          });
          return textResult(
            sections.join("\n\n") +
              (truncated
                ? `\n\n(${anchors.length - shown} more episode(s) not shown: the reply hit its size limit. Ask for fewer at a time, or a smaller before/after.)`
                : ""),
            { tool: "graphiti_browse", requested: anchors.length, shown, ok: true },
          );
        } catch (error) {
          return failed("graphiti_browse", resolved.agentId, error);
        }
      },
    },

    {
      name: "graphiti_note",
      label: "Note something to remember (Graphiti)",
      description:
        "Record one lasting fact, or correct one memory has wrong. The conversation is captured automatically, " +
        "so do NOT use this for things merely said — only when the user asks you to remember, or states a lasting " +
        "preference or rule. Write it so it still makes sense months later: full names, no pronouns. " +
        "Correcting? Give the right version and say what was wrong in the same sentence — that contradiction is what " +
        "retires the old fact instead of keeping both. It joins this conversation and is searchable once the batch commits.",
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
        // Capture reads the gateway's transcript store. If that read is broken,
        // everything below reports zero and looks calm, so it is said first.
        if (local.storeReadable === false) {
          details.storeReadable = false;
          lines.push(
            "Capture cannot read the conversation store" +
              (local.storePath ? ` at ${local.storePath}` : "") +
              "; nothing new is reaching memory until that is fixed. Nothing is lost meanwhile — the store keeps everything and capture resumes from where it stopped.",
          );
        }
        const untilFlush = cfg.bufferLimit - local.bufferedMessages;
        lines.push(
          local.bufferedMessages === 0 && local.queuedBatches === 0
            ? "Nothing is waiting locally: everything captured so far has been handed to the backend."
            : `Waiting locally: ${local.bufferedMessages} message(s) in the open batch` +
              (untilFlush > 0 ? ` (${untilFlush} more, or ${Math.round(cfg.bufferTimeout / 60)} min of silence, triggers the next commit)` : "") +
              (local.queuedBatches > 0 ? `, plus ${local.queuedBatches} batch(es) queued for delivery` : "") + ".",
        );

        // Handed over is not stored. The backend's own queue empties whether the
        // work succeeded or not, so a batch lost to a failed extraction appears
        // nowhere on the server side — only here.
        details.awaitingConfirmation = local.awaitingConfirmation;
        if (local.awaitingConfirmation > 0) {
          const age = local.oldestAwaitingMs ? `, oldest ${describeDuration(local.oldestAwaitingMs)}` : "";
          lines.push(
            `${local.awaitingConfirmation} batch(es) handed to the backend are not in the graph yet${age}. ` +
              "They are kept and retried until they land, so nothing is lost while the backend is unwell.",
          );
        }
        if (local.notLanding.length > 0) {
          details.notLanding = local.notLanding;
          flagProblem("batches_not_landing");
          lines.push(
            `PROBLEM: ${local.notLanding.length} batch(es) keep failing to land: ` +
              local.notLanding
                .map((batch) => `${batch.name} (${batch.attempts} attempts, ${describeDuration(batch.ageMs)})`)
                .join(", ") +
              ". They are still being retried, with a widening pause; if this persists the backend is rejecting them for a reason worth finding.",
          );
        }
        if (local.droppedForSpace > 0) {
          details.droppedForSpace = local.droppedForSpace;
          flagProblem("dropped_for_space");
          lines.push(
            `PROBLEM: ${local.droppedForSpace} batch(es) were dropped because the local store hit its size limit. Those messages are gone.`,
          );
        }

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
          // Counted through the same strict parse: an episode whose name does not
          // end in a batch number belongs to no dialog's sequence, and treating
          // its whole name as a prefix invented a second dialog that never existed.
          const dialogs = new Set(
            batches
              .map((e) => (typeof e.name === "string" ? splitEpisodeName(e.name)?.prefix : undefined))
              .filter((prefix): prefix is string => Boolean(prefix)),
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
          // A fork is invisible to the numbering check, because both branches
          // carry legitimate, different names — only the edges give it away.
          for (const row of rows(integrity.forked_episodes)) {
            graphProblems.push(`episode ${text(row.name)} has ${count(row.successors)} successors, so the chain forks there`);
          }
          if (count(integrity.episodes_without_saga) > 0) {
            graphProblems.push(`${count(integrity.episodes_without_saga)} episode(s) belong to no dialog`);
          }
          if (count(integrity.facts_without_provenance) > 0) {
            graphProblems.push(`${count(integrity.facts_without_provenance)} fact(s) name no source episode`);
          }
          // Stated, not counted as a problem: an episode taken out of the chain
          // on purpose is a repair, and repeating it as damage every time would
          // teach the reader to ignore this section.
          if (count(integrity.parked_episodes) > 0) {
            details.parkedEpisodes = count(integrity.parked_episodes);
            lines.push(
              `${count(integrity.parked_episodes)} episode(s) are parked outside the chain on purpose; their text is kept and searchable.`,
            );
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
