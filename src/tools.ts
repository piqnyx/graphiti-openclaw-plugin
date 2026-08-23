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
  "graphiti_repair",
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
/** Episodes fetched either side of an anchor, unless the caller says otherwise. */
const BROWSE_NEIGHBOURS = 3;
const MAX_BROWSE_NEIGHBOURS = 12;

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
  const { header, messages } = renderEpisodeParts(episode);
  return messages.length > 0 ? `${header}\n${messages.join("\n")}` : "";
}

/**
 * The same rendering, with the messages still separate.
 *
 * Trimming a transcript to fit has to cut between messages, never inside one: a
 * reply severed mid-sentence reads as if the speaker was interrupted, and the
 * model has no way to tell that from what was actually said. Only the caller that
 * assembles a window needs the parts, so `renderEpisode` above keeps its shape.
 */
export function renderEpisodeParts(
  episode: Record<string, unknown>,
): { header: string; messages: string[] } {
  const name = typeof episode.name === "string" ? episode.name : "";
  const header = `[${name}]`;
  const raw = typeof episode.content === "string" ? episode.content : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON: an episode stored by some other path. Show it as it is.
    return { header, messages: raw ? [raw] : [] };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) {
    return { header, messages: raw ? [raw] : [] };
  }
  const participants = isRecord(parsed.participants) ? parsed.participants : {};
  const speaker = (role: unknown): string => {
    if (role === "user") return text(participants.user) || "User";
    if (role === "assistant") return text(participants.assistant) || "Assistant";
    return text(role) || "Unknown";
  };

  const messages = parsed.messages
    .filter(isRecord)
    .map((message) => `${speaker(message.role)}: ${text(message.text)}`.trim())
    .filter((line) => !line.endsWith(":"));
  return { header, messages };
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
/**
 * Fit whole messages into a budget, keeping the ones nearest the anchor.
 *
 * `fromEnd` reads the side before the anchor, where the last message is the
 * closest one and the oldest is the first to go; the side after the anchor drops
 * from its own far end instead. What was dropped is counted rather than elided,
 * because a bare ellipsis tells the reader nothing about whether asking for a
 * bigger window would bring anything back.
 */
function fitMessages(
  sections: { header: string; messages: string[] }[],
  budget: number,
  fromEnd: boolean,
): { text: string; droppedMessages: number; shown: string[] } {
  const order = fromEnd ? [...sections].reverse() : sections;
  const kept: { header: string; messages: string[] }[] = [];
  let dropped = 0;
  let left = budget;

  for (const section of order) {
    const messages = fromEnd ? [...section.messages].reverse() : section.messages;
    const taken: string[] = [];
    for (const message of messages) {
      const cost = message.length + 1;
      if (cost > left) {
        dropped += 1;
        continue;
      }
      left -= cost;
      taken.push(message);
    }
    if (taken.length > 0) {
      // The header costs characters too, and a section reduced to its header
      // alone is noise; charge for it only once something survived under it.
      left -= section.header.length + 1;
      kept.push({ header: section.header, messages: fromEnd ? taken.reverse() : taken });
    }
  }

  const ordered = fromEnd ? kept.reverse() : kept;
  const text = ordered
    .map((section) => `${section.header}\n${section.messages.join("\n")}`)
    .join("\n");
  return { text, droppedMessages: dropped, shown: ordered.map((section) => section.header) };
}

function omitted(count: number, where: string, widen: string): string {
  // A count alone tells the reader something was cut and nothing about what to do
  // with that. The window starts deliberately narrow, so the note carries the way
  // out: the argument to change, and that calling again is how one reads on rather
  // than an admission that the first call failed.
  return count > 0
    ? `[… ${count} ${where} message(s) not shown — call again with ${widen} to read on]`
    : "";
}

async function readAround(
  client: GraphitiMcpClient,
  agentId: string,
  anchor: string,
  before: number,
  after: number,
  neighbours: number,
  share: number,
  seen: Set<string>,
): Promise<string> {
  const centre = (await client.getEpisodesByRef(agentId, { names: [anchor] }))[0];
  if (!centre) return "";

  const centreName = typeof centre.name === "string" ? centre.name : anchor;
  const position = splitEpisodeName(centreName);
  let window: Record<string, unknown>[] = [centre];
  if (position && neighbours > 0) {
    const names: string[] = [];
    for (let step = 1; step <= neighbours; step += 1) {
      if (position.number - step > 0) names.push(`${position.prefix}-${position.number - step}`);
      names.push(`${position.prefix}-${position.number + step}`);
    }
    const found = await client.getEpisodesByRef(agentId, { names });
    window = [...found, centre];
  }

  const ordered = window
    .map((episode) => ({ episode, at: splitEpisodeName(typeof episode.name === "string" ? episode.name : "")?.number ?? 0 }))
    .sort((a, b) => a.at - b.at)
    .filter((entry, index, all) => index === 0 || entry.episode.name !== all[index - 1]?.episode.name);

  const centreIndex = Math.max(ordered.findIndex((entry) => entry.episode.name === centreName), 0);
  let parts = ordered.map((entry) => renderEpisodeParts(entry.episode));

  // Anchors close together share neighbours, and printing the same exchange under
  // each of them doubles the reply for nothing -- two anchors four episodes apart
  // repeated three episodes verbatim, which is what pushed a reply past the host's
  // own ceiling. An episode already shown becomes a reference to where it is.
  if (seen.has(parts[centreIndex]?.header ?? "")) {
    return `── ${centreName} ── already shown above`;
  }
  parts = parts.map((section, index) =>
    index !== centreIndex && seen.has(section.header)
      ? { header: `${section.header} — shown above`, messages: [] }
      : section,
  );
  for (const section of parts) seen.add(section.header);

  // The anchor is the answer and the neighbours are context, so the anchor is
  // served first and only what is left goes to either side. Before this the
  // anchor was never trimmed at all: one episode of eleven thousand characters
  // consumed the whole reply, and everything after it was cut mid-sentence by a
  // blind slice over the assembled text.
  const centreParts = parts[centreIndex] ?? { header: `[${centreName}]`, messages: [] };
  const body = fitMessages([centreParts], share, false);
  let left = Math.max(0, share - body.text.length);

  // Each side is capped by what was asked for and by what the anchor left over.
  const headBudget = Math.min(before, left);
  const head = fitMessages(parts.slice(0, centreIndex), headBudget, true);
  left = Math.max(0, left - head.text.length);
  const tail = fitMessages(parts.slice(centreIndex + 1), Math.min(after, left), false);

  const transcript = [
    omitted(head.droppedMessages, "earlier", `before: ${before * 4 || 2048}, after: 0`),
    head.text,
    body.text,
    tail.text,
    omitted(
      tail.droppedMessages + body.droppedMessages,
      "later",
      `before: 0, after: ${after * 4 || 2048}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
  if (!transcript) return "";

  // The heading names the anchor, and the episodes under it are whatever the
  // window reached. Saying only the anchor made a section of four episodes look
  // like one, which is the difference between "this is all there is" and "this is
  // where I stopped".
  const span = [...head.shown, ...body.shown, ...tail.shown];
  const reach = span.length > 1 ? ` (${span[0]} … ${span[span.length - 1]})` : "";
  return `── ${centreName}${reach} ──\n${transcript}`;
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
        "Search this agent's memory across all its dialogs. Three kinds of hit: " +
        "[fact] what is known, in the extractor's words rather than quoted; [entity] a person, place or project; " +
        "[episode] a piece of conversation that matched. " +
        "The number after the kind is how well it matches the query, not its position: 0.4 is a good answer, 0.15 is a distant one. " +
        "Anything too weak to be worth reading is withheld, so an empty answer means memory has nothing — not that the search failed. " +
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
          // Entities carry their own episodes, and those uuids have to be resolved
          // too -- a name that never reached this map renders as no source at all.
          const referenced = new Set(uuidCounts.keys());
          for (const entity of entities) {
            for (const uuid of asStrings(entity.episodes)) referenced.add(uuid);
          }
          const names = await resolveEpisodeNames(client, resolved.agentId, [...referenced]);

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
              ? `\n  -> Source episodes: ${ordered.map(([name, hits]) => (hits > 1 ? `${name} (${hits})` : name)).join(", ")}`
              : "";
          };

          // The backend reports where an entity was mentioned. Falling back to the
          // facts that touch it covers an older server, and leaves an entity whose
          // facts did not rank in this result without a source rather than wrong.
          const entityAnchors = (entity: Record<string, unknown>): string[] => {
            const own = asStrings(entity.episodes);
            if (own.length > 0) return own;
            const uuid = text(entity.uuid);
            return facts
              .filter((fact) => text(fact.source_node_uuid) === uuid || text(fact.target_node_uuid) === uuid)
              .flatMap((fact) => asStrings(fact.episodes));
          };

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
                anchorsFor(entityAnchors(entity)),
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
          if (lines.length === 0) {
            // An empty answer has to say it is empty. The server now withholds
            // everything that scored below the relevance floor, which is the point
            // -- but rendering that as a blank tool result tells the model nothing,
            // and a model that cannot tell "no match" from "the tool broke" will
            // either invent an answer or retry the same query.
            return textResult(
              "Nothing in memory matched that closely enough to be worth showing. " +
                "Memory has no answer here: say so, or look somewhere it might be — " +
                "the OpenViking tools, or the web.",
              { tool: "graphiti_search", facts: 0, entities: 0, episodes: 0, ok: true },
            );
          }
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
        "Read what was actually said, in the dialog it was said in. " +
        "Anchors come from two places: the hits of graphiti_search, and the memory injected before a reply — every quoted memory names the episode it came from. " +
        "Pass several at once, from different hits if you like. " +
        "The window is small by design and meant to be widened: read the little that comes back, and if the answer is not in it, call again with a bigger before/after — " +
        "or one side only, like before: 0, after: 4000, to walk forward through the conversation without re-reading what you have. " +
        "Several calls in a row is how this tool is used, not a sign the first one failed. " +
        "Costlier than searching: use it when the exact wording, tone or surrounding exchange matters.",
      parameters: {
        type: "object",
        properties: {
          episodes: {
            type: "array",
            items: {
              anyOf: [
                { type: "string" },
                {
                  type: "object",
                  properties: {
                    episode: { type: "string" },
                    before: { type: "number" },
                    after: { type: "number" },
                  },
                  required: ["episode"],
                },
              ],
            },
            description:
              "Anchors to read around, such as 8248439450-12. Give a name for the default window, " +
              "or {episode, before, after} to size that one yourself. The two forms mix freely: " +
              "read one exchange closely and glance at the rest in the same call.",
          },
          episode: { type: "string", description: "A single anchor, if you have only one." },
          query: { type: "string", description: "Used only when no anchors are given: finds the conversation behind the best match." },
          before: { type: "number", description: `Characters before an anchor that did not size itself. Default ${cfg.browseChars}, maximum ${cfg.browseMaxChars}.` },
          after: { type: "number", description: `Characters after such an anchor. Default ${cfg.browseChars}, maximum ${cfg.browseMaxChars}.` },
          neighbours: { type: "number", description: `Episodes fetched either side of an anchor. Default ${BROWSE_NEIGHBOURS}, maximum ${MAX_BROWSE_NEIGHBOURS}. Raise it to reach further back than the default window can.` },
        },
      },
      async execute(_toolCallId, params, ctx) {
        const resolved = resolve("graphiti_browse", ctx);
        if ("refusal" in resolved) return resolved.refusal;

        const before = limitParam(params, "before", cfg.browseChars, cfg.browseMaxChars);
        const after = limitParam(params, "after", cfg.browseChars, cfg.browseMaxChars);
        const neighbours = limitParam(params, "neighbours", BROWSE_NEIGHBOURS, MAX_BROWSE_NEIGHBOURS);

        // An anchor is either a bare name or a name with its own window. Both
        // forms are accepted whatever the schema says, because a model that only
        // ever emits strings must not lose the feature, and one that sizes every
        // anchor must not be forced to repeat the default.
        const asked: { name: string; before: number; after: number }[] = [];
        const seen = new Set<string>();
        const remember = (raw: unknown): void => {
          const entry = isRecord(raw) ? raw : { episode: raw };
          const name = sanitizeConversationText(text(entry.episode ?? entry.name)).trim();
          if (!name || seen.has(name)) return;
          seen.add(name);
          asked.push({
            name,
            before: limitParam(entry, "before", before, cfg.browseMaxChars),
            after: limitParam(entry, "after", after, cfg.browseMaxChars),
          });
        };
        if (Array.isArray(params.episodes)) for (const item of params.episodes) remember(item);
        remember(stringParam(params, "episode"));

        const requested = asked.slice(0, cfg.browseMaxEpisodes);
        const query = sanitizeConversationText(stringParam(params, "query"));
        if (requested.length === 0 && !query) {
          return errorResult("graphiti_browse needs either episode names or a query.", {
            tool: "graphiti_browse",
            reason: "no_anchor",
          });
        }

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
            anchors = [...new Set(names)]
              .slice(0, cfg.browseMaxEpisodes)
              .map((name) => ({ name, before, after }));
          }

          if (anchors.length === 0) {
            return textResult(
              "Nothing in memory matches that, so there is no conversation to show. Try graphiti_search, or the OpenViking search tools.",
              { tool: "graphiti_browse", results: 0, ok: true },
            );
          }

          const sections: string[] = [];
          // What has already been printed in this reply, so overlapping windows
          // point at each other instead of repeating.
          const seen = new Set<string>();
          let budget = cfg.browseMaxTotalChars;
          // An equal share each, so asking for five anchors returns five. Draining
          // one pot in order let the first anchor spend everything and the last
          // arrive empty, which is the opposite of what asking for several means.
          const share = Math.max(1, Math.floor(cfg.browseMaxTotalChars / anchors.length));
          let shown = 0;
          for (const anchor of anchors) {
            if (budget <= 0) break;
            const section = await readAround(
              client,
              resolved.agentId,
              anchor.name,
              anchor.before,
              anchor.after,
              neighbours,
              Math.min(share, budget),
              seen,
            );
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
        "Note one lasting thing worth remembering — the moment you would say 'ah, that I'll remember'. " +
        "The conversation is already stored whole and by itself, so anything that was said is in memory " +
        "whether you note it or not, and whatever of it matters comes back on its own before later replies. " +
        "A note neither speeds that up nor improves it. " +
        "A note is for what the conversation did not state outright: a habit you " +
        "noticed, a preference that showed itself, a rule that will matter later, or something you were asked to keep. " +
        "Never retell what just happened — a digest of the last few turns is the one thing this tool must not hold. " +
        "Write it in the language being spoken: this description is in English, the note is not. " +
        "A note in another language mints a second, separate set of names for the same people and " +
        "places, and nothing said afterwards merges them back. " +
        "State it about the world in the third person, full names, no pronouns, still true months from now. " +
        "Never address memory and never describe your own actions: being asked to remember something is a fact " +
        "about the asking, not about the world, and it ages into a false one. " +
        "It joins this conversation and is searchable once the batch commits.",
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "The fact, stated in the third person as one or a few self-contained sentences.",
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
      name: "graphiti_repair",
      label: "Repair memory (Graphiti)",
      description:
        "Repair the shape of memory, when a note cannot. A note states a fact; this changes the graph itself. " +
        "mode=\"merge\": one thing is recorded twice under different names — everything attached to `duplicate` moves " +
        "onto `canonical` and `duplicate` ceases to exist. Use it when search returns the same subject twice under " +
        "different spellings, or a name in the wrong grammatical case. " +
        "Not for the opposite case: if two similar names are genuinely different things, say so in a graphiti_note " +
        "instead — nothing needs repairing, and the statement keeps them from being merged later. " +
        "Names must be exactly as memory holds them; check with graphiti_search first. " +
        "preview=true reports what would move without moving it. This destroys one entity, so use it when something " +
        "is actually wrong — not to tidy.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["merge"], description: "What to repair. Only merge for now." },
          duplicate: { type: "string", description: "The name to fold away, exactly as memory holds it." },
          canonical: { type: "string", description: "The name to keep, exactly as memory holds it." },
          preview: { type: "boolean", description: "Report what would move without changing anything." },
        },
        required: ["mode", "duplicate", "canonical"],
      },
      async execute(_toolCallId, params, ctx) {
        const resolved = resolve("graphiti_repair", ctx);
        if ("refusal" in resolved) return resolved.refusal;

        const mode = stringParam(params, "mode").trim();
        if (mode !== "merge") {
          return errorResult(`graphiti_repair does not know mode "${mode}". The only mode is merge.`, {
            tool: "graphiti_repair",
            reason: "unknown_mode",
            mode,
          });
        }

        const duplicate = sanitizeConversationText(stringParam(params, "duplicate")).trim();
        const canonical = sanitizeConversationText(stringParam(params, "canonical")).trim();
        if (!duplicate || !canonical) {
          return errorResult("graphiti_repair needs both duplicate and canonical names.", {
            tool: "graphiti_repair",
            reason: "missing_names",
          });
        }

        const preview = params.preview === true;
        try {
          const result = await client.mergeEntities(resolved.agentId, duplicate, canonical, preview);
          const moved = (result.moved ?? result.would_move) as Record<string, unknown> | undefined;
          const counts = moved
            ? `${moved.mentions ?? 0} mention(s), ${moved.outgoing_facts ?? 0} outgoing and ${moved.incoming_facts ?? 0} incoming fact(s)`
            : "nothing";
          logger.info("tool_repair", {
            agentId: resolved.agentId,
            group_id: resolved.agentId,
            mode,
            duplicate,
            canonical,
            preview,
            applied: result.applied === true,
          });
          return textResult(
            preview
              ? `Folding "${duplicate}" into "${canonical}" would move ${counts}. Nothing changed yet.`
              : `"${duplicate}" is now part of "${canonical}"; ${counts} moved across. Existing fact sentences keep their original wording.`,
            { tool: "graphiti_repair", mode, duplicate, canonical, preview, ok: true },
          );
        } catch (error) {
          return failed("graphiti_repair", resolved.agentId, error);
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
