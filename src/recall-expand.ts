import type { GraphitiMcpClient } from "./mcp-client.js";
import type { EpisodeMessage } from "./text.js";
import { episodeMessages } from "./text.js";

type JsonObject = Record<string, unknown>;

/**
 * Showing the conversation a recalled fact came from.
 *
 * A fact is a sentence the extractor wrote, and it is often true and useless on its
 * own: "Вит переехал" says nothing about when, from where, or whether he was pleased
 * about it. The conversation says all three and is already stored -- every fact
 * carries the uuids of the episodes it was drawn from.
 *
 * The excerpt is cut at message boundaries, and the message to cut around is chosen
 * by how many words it shares with the fact. An earlier version looked for the fact's
 * proper nouns instead, which meant a rule about what a name looks like: it missed
 * `C++` because of the plus signs, and it settled on `Вит` -- a word in every line of
 * the episode -- so the excerpt showed the greeting. Every such rule is a list of the
 * spellings someone thought of, and `.NET`, `C#` and an all-caps abbreviation are the
 * ones nobody thinks of. Shared words need no such list.
 */

/** The name of the episode a fact came from, and optionally the conversation itself. */
export type FactSource = { episode: string; excerpt?: string };

/** Marks a message shown only in part. */
const OMITTED = "(…omitted…)";
/** Marks messages dropped above or below the excerpt. */
const ELISION = "…";
/** Below this a word carries no signal: prepositions, particles, "это", "как". */
const MIN_WORD = 4;

function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#._-]*/gu) ?? [])
    // The dot and dash are kept inside a word for the sake of C++, .NET and bge-m3,
    // and that same class swallows the full stop ending a sentence -- which made
    // "Яндекса." and "Яндекса" two different words and lost the match.
    .map((word) => word.replace(/[._-]+$/u, ""))
    .filter((word) => word.length >= MIN_WORD);
}

/**
 * Which message the fact was most likely drawn from.
 *
 * Overlap of words, counted once each: a message repeating one word of the fact ten
 * times is not ten times the match. Nothing matched means the last message, because
 * within a batch the conversation runs forward and a freshly written fact most often
 * came from its end.
 */
export function bestMessage(messages: readonly EpisodeMessage[], fact: string): number {
  const wanted = new Set(words(fact));
  if (wanted.size === 0 || messages.length === 0) return messages.length - 1;

  let bestAt = -1;
  let bestScore = 0;
  for (let at = 0; at < messages.length; at += 1) {
    const seen = new Set(words(messages[at]?.text ?? ""));
    let score = 0;
    for (const word of wanted) if (seen.has(word)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      bestAt = at;
    }
  }
  return bestAt >= 0 ? bestAt : messages.length - 1;
}

function render(message: EpisodeMessage, budget: number): string {
  const head = `[${message.speaker}] `;
  const room = Math.max(0, budget - head.length);
  const text = message.text.trim();
  if (text.length <= room) return `${head}${text}`;
  // Cut from the middle: the opening says what is being talked about and the closing
  // often carries the point, and losing either to keep the other reads worse than
  // losing the middle and saying so.
  const side = Math.max(8, Math.floor((room - OMITTED.length) / 2));
  return `${head}${text.slice(0, side)}${OMITTED}${text.slice(-side)}`;
}

/**
 * The messages around the chosen one, as many as the budget allows.
 *
 * Grown outward one message at a time, later first: what was said after a statement
 * is usually the reply to it, and a reply is what makes a statement legible.
 */
export function excerptAround(
  messages: readonly EpisodeMessage[],
  at: number,
  budget: number,
): string {
  if (messages.length === 0 || at < 0) return "";

  const centre = render(messages[at] as EpisodeMessage, budget);
  const lines = new Map<number, string>([[at, centre]]);
  let used = centre.length;

  let before = at - 1;
  let after = at + 1;
  let takeAfter = true;
  while (before >= 0 || after < messages.length) {
    const next = takeAfter && after < messages.length ? after : before;
    if (next < 0 || next >= messages.length) {
      takeAfter = !takeAfter;
      continue;
    }
    const line = render(messages[next] as EpisodeMessage, budget);
    if (used + line.length + 1 > budget) break;
    lines.set(next, line);
    used += line.length + 1;
    if (next === after) after += 1;
    else before -= 1;
    takeAfter = !takeAfter;
  }

  const shown = [...lines.keys()].sort((left, right) => left - right);
  const body = shown.map((index) => lines.get(index) as string);
  if ((shown[0] ?? 0) > 0) body.unshift(ELISION);
  if ((shown[shown.length - 1] ?? 0) < messages.length - 1) body.push(ELISION);
  return body.join("\n");
}

/** Every episode uuid the facts name, in order, without repeats. */
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
 * Where each fact came from, and what was said around the first few.
 *
 * The episode is named for every fact, not only the quoted ones: naming it costs a
 * line and turns each fact into something she can go and read for herself. One fetch
 * covers them all, because the returned facts routinely share a batch.
 */
export async function factSources(
  client: GraphitiMcpClient,
  agentId: string,
  facts: readonly JsonObject[],
  quoteTop: number,
  chars: number,
): Promise<(FactSource | undefined)[]> {
  const uuids = sourceUuids(facts);
  if (uuids.length === 0) return facts.map(() => undefined);

  const episodes = await client.getEpisodesByRef(agentId, { uuids });
  const known = new Map<string, { name: string; messages: EpisodeMessage[] }>();
  for (const episode of episodes) {
    if (typeof episode.uuid !== "string") continue;
    known.set(episode.uuid, {
      name: typeof episode.name === "string" ? episode.name : "",
      messages: episodeMessages(typeof episode.content === "string" ? episode.content : ""),
    });
  }

  // Facts ranked together routinely come from the same batch, and two of them often
  // point at the same passage of it. Printing that passage twice spends the budget on
  // nothing: the second fact still names its episode, and the quote is already above.
  const quoted = new Set<string>();

  return facts.map((fact, index) => {
    const episodeUuids = Array.isArray(fact.episodes) ? fact.episodes : [];
    const uuid = episodeUuids.find((value: unknown): value is string => typeof value === "string" && value !== "");
    const source = uuid ? known.get(uuid) : undefined;
    if (!source?.name) return undefined;
    if (index >= quoteTop) return { episode: source.name };

    const text = typeof fact.fact === "string" ? fact.fact : "";
    const excerpt = excerptAround(source.messages, bestMessage(source.messages, text), chars * 2);
    if (!excerpt || quoted.has(excerpt)) return { episode: source.name };
    quoted.add(excerpt);
    return { episode: source.name, excerpt };
  });
}
