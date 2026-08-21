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
  // Trailing symbols belong to the name: C++ and F# are the whole word, and a
  // candidate cut down to "C" matches everywhere and locates nothing.
  const found = fact.match(/\p{Lu}[\p{L}\p{N}._-]*[\p{L}\p{N}][+#]*|\p{Lu}[\p{L}\p{N}]*[+#]+/gu) ?? [];
  return [...new Set(found)].filter((word) => word.length >= 2);
}

/**
 * The anchor is the rarest candidate, not the longest.
 *
 * Measured on the live graph: expanding "Вит изучал C++ 2 года назад" anchored on
 * "Вит", which opens the episode and appears in almost every line of it, so the
 * window landed on the greeting and said nothing about C++. A word that appears
 * once points at one passage; a word that appears thirty times points at the
 * episode, which the reader already has.
 */
/**
 * How often a word may appear and still point somewhere.
 *
 * A name scattered through the episode describes the whole of it, and a window
 * around its first occurrence is then no better than an arbitrary cut -- worse,
 * because it looks deliberate. Past this many, the tail is the honest answer.
 */
const ANCHOR_MAX_OCCURRENCES = 3;

export function chooseAnchor(text: string, candidates: readonly string[]): string | undefined {
  const lower = text.toLowerCase();
  let best: { word: string; count: number } | undefined;
  for (const word of candidates) {
    const needle = word.toLowerCase();
    let count = 0;
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
      count += 1;
      if (count > 64) break;
    }
    if (count === 0) continue;
    if (!best || count < best.count || (count === best.count && word.length > best.word.length)) {
      best = { word, count };
    }
  }
  return best && best.count <= ANCHOR_MAX_OCCURRENCES ? best.word : undefined;
}

/**
 * Shrink a cut to whole lines without letting go of the anchor.
 *
 * Snapping the start forward is what keeps a window from opening mid-word, and it
 * is also what can step straight over the line the window exists to show, when the
 * anchor sits near the top of the cut. So the snap stops at the anchor's own line
 * in both directions.
 */
function toLineBounds(text: string, start: number, end: number, at: number): [number, number] {
  const anchorLineStart = at < 0 ? start : text.lastIndexOf("\n", at) + 1;
  const anchorLineEnd = at < 0 ? end : (text.indexOf("\n", at) + 1 || text.length + 1) - 1;

  const snappedStart = start === 0 ? 0 : text.indexOf("\n", start) + 1;
  const snappedEnd = end >= text.length ? text.length : text.lastIndexOf("\n", end);
  const from = snappedStart > 0 ? Math.min(snappedStart, anchorLineStart) : 0;
  const to = snappedEnd > from ? Math.max(snappedEnd, anchorLineEnd) : end;
  if (to <= from) return [start, end];

  // Whole lines are a courtesy, the budget is not. One pasted wall of text is a
  // single line thousands of characters long, and rounding out to it would inject
  // the wall. Past twice what was asked for, the character cut wins.
  const bounded = Math.min(to, text.length);
  if (bounded - from > (end - start) * 2) return [start, end];
  return [from, bounded];
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
  const anchor = chooseAnchor(text, anchors);
  const at = anchor ? text.toLowerCase().indexOf(anchor.toLowerCase()) : -1;

  const rawStart = at < 0 ? Math.max(0, text.length - chars * 2) : Math.max(0, at - chars);
  const rawEnd = at < 0 ? text.length : Math.min(text.length, at + (anchor?.length ?? 0) + chars);
  const [start, end] = toLineBounds(text, rawStart, rawEnd, at);
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
export type FactContext = { anchor: string; text: string };

export async function expandFacts(
  client: GraphitiMcpClient,
  agentId: string,
  facts: readonly JsonObject[],
  chars: number,
): Promise<(FactContext | undefined)[]> {
  const uuids = sourceUuids(facts);
  if (uuids.length === 0) return facts.map(() => undefined);

  const episodes = await client.getEpisodesByRef(agentId, { uuids });
  const rendered = new Map<string, FactContext>();
  for (const episode of episodes) {
    if (typeof episode.uuid !== "string") continue;
    const name = typeof episode.name === "string" ? episode.name : "";
    // The renderer opens with the episode name in brackets. It belongs in the label
    // the reader sees, not inside the quoted conversation -- printed there it shows
    // up only when the window happens to start at the top, which reads as noise
    // appearing at random.
    const body = renderEpisode(episode).replace(/^\[[^\]\n]*\]\n/, "");
    rendered.set(episode.uuid, { anchor: name, text: body });
  }

  return facts.map((fact) => {
    const episodeUuids = Array.isArray(fact.episodes) ? fact.episodes : [];
    const uuid = episodeUuids.find((value: unknown): value is string => typeof value === "string" && value !== "");
    const source = uuid ? rendered.get(uuid) : undefined;
    if (!source?.text) return undefined;
    const window = windowAround(
      source.text,
      anchorCandidates(typeof fact.fact === "string" ? fact.fact : ""),
      chars,
    );
    return window ? { anchor: source.anchor, text: window } : undefined;
  });
}
