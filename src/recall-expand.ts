import type { GraphitiMcpClient } from "./mcp-client.js";
import { renderEpisode } from "./tools.js";

type JsonObject = Record<string, unknown>;

/**
 * Showing the conversation a recalled fact came from.
 *
 * A fact is a sentence the extractor wrote, and it is often true and useless on its
 * own: "Вит переехал" says nothing about when, or from where, or whether he was
 * pleased about it. The conversation behind it says all three, and it is already in
 * the store -- every fact carries the uuids of the episodes it was drawn from.
 *
 * Only the first few facts are expanded, and only a window around the point the fact
 * came from. The whole episode is a batch of up to twenty messages, and injecting one
 * of those on every turn would bury the short facts it was meant to support.
 */

/**
 * Where in the episode to cut.
 *
 * The fact is a paraphrase, so it does not appear verbatim anywhere. Its proper nouns
 * usually do -- they are copied from what was said rather than rewritten -- so the
 * longest capitalised word is the most specific thing to look for. Longest first,
 * because "Кобулети" locates a passage and "Вит" locates the whole conversation.
 */
export function anchorCandidates(fact: string): string[] {
  const found = fact.match(/\p{Lu}[\p{L}\p{N}._+-]{2,}/gu) ?? [];
  const unique = [...new Set(found)];
  return unique.sort((left, right) => right.length - left.length);
}

/**
 * The window, with an ellipsis wherever text was cut away.
 *
 * Falls back to the end of the episode when no anchor is found: within a batch the
 * conversation runs forward in time, so the newest statement is the likeliest source
 * of a fact that was just written.
 */
export function windowAround(text: string, anchors: readonly string[], chars: number): string {
  if (!text) return "";
  const lower = text.toLowerCase();
  let at = -1;
  let anchorLength = 0;
  for (const anchor of anchors) {
    const found = lower.indexOf(anchor.toLowerCase());
    if (found >= 0) {
      at = found;
      anchorLength = anchor.length;
      break;
    }
  }

  const start = at < 0 ? Math.max(0, text.length - chars * 2) : Math.max(0, at - chars);
  const end = at < 0 ? text.length : Math.min(text.length, at + anchorLength + chars);
  const cut = text.slice(start, end).trim();
  if (!cut) return "";
  return `${start > 0 ? "…" : ""}${cut}${end < text.length ? "…" : ""}`;
}

/** The episode uuids the top facts were drawn from, in order, without repeats. */
function sourceUuids(facts: readonly JsonObject[]): string[] {
  const uuids: string[] = [];
  for (const fact of facts) {
    const episodes = Array.isArray(fact.episodes) ? fact.episodes : [];
    const first = episodes.find((uuid: unknown): uuid is string => typeof uuid === "string" && uuid !== "");
    if (first && !uuids.includes(first)) uuids.push(first);
  }
  return uuids;
}

/**
 * A window of conversation per fact, aligned with the facts given.
 *
 * One fetch for every episode involved rather than one per fact: several of the top
 * facts routinely come from the same batch. An entry is empty when the fact names no
 * source, when the episode is gone, or when it rendered to nothing -- recall must
 * still return its facts.
 */
export async function expandFacts(
  client: GraphitiMcpClient,
  agentId: string,
  facts: readonly JsonObject[],
  chars: number,
): Promise<string[]> {
  const uuids = sourceUuids(facts);
  if (uuids.length === 0) return facts.map(() => "");

  const episodes = await client.getEpisodesByRef(agentId, { uuids });
  const rendered = new Map<string, string>();
  for (const episode of episodes) {
    if (typeof episode.uuid !== "string") continue;
    rendered.set(episode.uuid, renderEpisode(episode));
  }

  return facts.map((fact) => {
    const episodeUuids = Array.isArray(fact.episodes) ? fact.episodes : [];
    const uuid = episodeUuids.find((value: unknown): value is string => typeof value === "string" && value !== "");
    const text = uuid ? rendered.get(uuid) ?? "" : "";
    if (!text) return "";
    return windowAround(text, anchorCandidates(typeof fact.fact === "string" ? fact.fact : ""), chars);
  });
}
