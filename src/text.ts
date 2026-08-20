// (text.ts — утилиты санитизации conversation messages и recall)

const GRAPHITI_CONTEXT_RE = /<graphiti-context\b[^>]*>[\s\S]*?<\/graphiti-context>/gi;
const OPENVIKING_CONTEXT_RE = /<openviking-context\b[^>]*>[\s\S]*?<\/openviking-context>/gi;
const OPENVIKING_MEMORIES_RE = /<relevant-memories\b[^>]*>[\s\S]*?<\/relevant-memories>/gi;
/**
 * The gateway's own runtime context, wrapped in explicit markers.
 *
 * OpenClaw prepends a block to the user's message carrying the chat id, the
 * sender's name and username, session identifiers, and — the reason this matters
 * — the recent traffic of *other* sessions. Captured verbatim it puts another
 * conversation's content into this agent's episode, and extraction then mints
 * entities and facts out of it.
 *
 * The block announces its own end, and the user's actual message is whatever
 * follows that marker — so everything up to and including it goes, preamble and
 * all. Cutting only between the markers left the gateway's own opening sentence
 * behind, which is boilerplate the graph has no use for either.
 *
 * A block with no closing marker means the message was truncated mid-context;
 * what arrived is still internal state, so it goes to the end of the text.
 */
const OPENCLAW_INTERNAL_CONTEXT_RE = /^[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/;
const OPENCLAW_UNCLOSED_CONTEXT_RE = /<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*$/;
/**
 * OpenClaw repeats the current message after the context block, so stripping the
 * block leaves the same text twice. Only an exact whole-text duplicate is
 * collapsed — anything less certain would risk eating a genuine repetition.
 */
const WHOLE_TEXT_DUPLICATE_RE = /^([\s\S]+)\n\1$/;
/**
 * The same duplicate, with the quotes the transcript marker left behind.
 *
 * A stored voice turn reads `текст"\n[Audio transcript …]: "текст`. Removing the
 * marker leaves `текст"\n"текст`, which is the same sentence twice but no longer
 * an exact duplicate, so the plain rule above walks past it and both copies reach
 * the graph.
 */
const QUOTED_DUPLICATE_RE = /^([\s\S]+?)"?\n"?\1$/;
const CONVERSATION_METADATA_RE =
  /(?:^|\n)\s*(?:Conversation info|Conversation metadata)\s*(?:\([^)]+\))?\s*:\s*```(?:json)?[\s\S]*?```/gi;
const SENDER_METADATA_RE = /(?:^|\n)\s*Sender\s*\([^)]*\)\s*:\s*```(?:json)?[\s\S]*?```/gi;
/**
 * OpenClaw prefixes machine transcription with a provenance marker, e.g.
 * `[Audio transcript (machine-generated, untrusted)]: "текст"`. The marker exists
 * for the live prompt; storing it would put the wrapper itself into the graph and
 * let extraction mint entities out of it.
 */
const TRANSCRIPT_PREFIX_RE = /(^|\n)[ \t]*\[[^\]\n]{0,160}transcript[^\]\n]{0,160}\][ \t]*:[ \t]*/gi;
/**
 * TTS directives the model writes into its own reply.
 *
 * OpenClaw lets a reply carry `[[tts:speakerVoiceId=… speed=…]]` to steer the
 * voice, and `[[tts:text]]…[[/tts:text]]` to give wording that belongs only to
 * the audio. The gateway strips these before the channel renders them, but
 * capture reads the model's raw output, so they arrive here intact — and stored
 * as-is they become entities: extraction has no way to know that `eleven_v3` is
 * a voice model rather than a thing worth remembering.
 *
 * The parameter form is machinery and goes entirely. The text form is speech the
 * assistant actually uttered, so only its markers go and the words stay — the
 * same rule already applied to transcription markers.
 */
/**
 * Delivery machinery the model writes into its own reply.
 *
 * The vocabulary is closed and taken from the gateway itself: `[[tts …]]` and
 * `[[/tts:text]]` (src/tts/directives.ts), and `[[audio_as_voice]]`,
 * `[[reply_to_current]]`, `[[reply_to: id]]` (src/utils/directive-tags.ts, which
 * also allows padding inside the brackets). Matching that vocabulary rather than
 * "anything bracketed" keeps prose that merely uses double brackets intact.
 *
 * `[[reply_to_current]]` is why this matters beyond tidiness: OpenClaw briefly
 * stores an assistant message whose whole body is that tag and then replaces it
 * with the real reply, so captured verbatim it mutates under the delta.
 *
 * The `[[tts:text]]…[[/tts:text]]` pair is speech the assistant actually uttered,
 * so its markers go first and the words between them stay.
 */
const TTS_TEXT_MARKER_RE = /\[\[\s*\/?\s*tts\s*:\s*text\s*\]\]/gi;
const TTS_DIRECTIVE_RE = /\[\[\s*\/?\s*tts\b[^\]\n]*\]\]/gi;
const DELIVERY_DIRECTIVE_RE =
  /\[\[\s*(?:audio_as_voice|reply_to_current|reply_to\s*:\s*[^\]\n]*)\s*\]\]/gi;
const TOOL_CALL_BLOCK_RE = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
const TOOL_CALL_TEXT_PARAM_RE = /<parameter=text>([\s\S]*?)<\/parameter>/i;

function unwrapToolCallBlocks(text: string): string {
  return text.replace(TOOL_CALL_BLOCK_RE, (_whole, inner: string) => {
    const spoken = TOOL_CALL_TEXT_PARAM_RE.exec(inner);
    return spoken ? spoken[1]! : "";
  });
}
const LEADING_TIMESTAMP_RE =
  /^\s*\[(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+)?\d{4}[-/]\d{2}[-/]\d{2}[^\]]*\]\s*/i;

export const SESSION_RESET_PROMPT_PREFIX = "A new session was started via /new or /reset";

type ContentBlock = {
  type?: unknown;
  text?: unknown;
};

type MessageLike = {
  role?: unknown;
  content?: unknown;
  /**
   * Where the message came from. `kind: "internal_system"` marks the gateway
   * talking to itself -- heartbeat polls and the like -- wearing the user role.
   */
  provenance?: unknown;
  /**
   * Set by the gateway on a message carrying transient current-turn runtime
   * context. Such a message exists only on the turn that produced it and is
   * stripped on replay, so treating it as history makes the transcript look
   * rewritten on the very next observation.
   */
  runtimeContextCarrier?: unknown;
};

/**
 * The gateway polling itself, dressed as the user.
 *
 * A heartbeat arrives with `role: "user"` and the body `[OpenClaw heartbeat poll]`,
 * distinguishable only by `provenance.kind`. Captured, it becomes a line the user
 * never said, and extraction has no way to know that.
 */
function isInternalSystemMessage(provenance: unknown): boolean {
  if (!provenance || typeof provenance !== "object") return false;
  return (provenance as { kind?: unknown }).kind === "internal_system";
}

export type ConversationMessage = {
  role: "user" | "assistant";
  text: string;
};

export type RecallQueryOptions = {
  useHistory: boolean;
  historyMaxMessages: number;
  historyMaxChars: number;
  maxChars: number;
  userName?: string;
  assistantName?: string;
};

export type RecallBlockResult = {
  block?: string;
  injectedFacts: number;
  skippedFacts: number;
};

export function stripInjectedContexts(text: string): string {
  return text
    .replace(GRAPHITI_CONTEXT_RE, " ")
    .replace(OPENVIKING_CONTEXT_RE, " ")
    .replace(OPENVIKING_MEMORIES_RE, " ");
}

/**
 * Remove the transcription provenance marker and unwrap the quoted transcript.
 *
 * The marker is not always first. OpenClaw stores a voice turn as the plain text
 * followed by the marked-up transcript, so anchoring the pattern to the start of
 * the message left the wrapper sitting in the middle -- and extraction then mints
 * entities out of the words "Audio transcript machine-generated untrusted".
 * Matching at any line start removes it wherever the gateway put it.
 */
function stripTranscriptWrapper(text: string): string {
  const withoutMarker = text.replace(TRANSCRIPT_PREFIX_RE, "$1");
  if (withoutMarker === text) return text;

  const trimmed = withoutMarker.trim();
  // Only the pair the marker itself added is removed; quotes inside stay put.
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return withoutMarker;
}

export function sanitizeConversationText(text: string): string {
  return stripTranscriptWrapper(
    unwrapToolCallBlocks(stripInjectedContexts(text))
      .replace(OPENCLAW_INTERNAL_CONTEXT_RE, "")
      .replace(OPENCLAW_UNCLOSED_CONTEXT_RE, "")
      .replace(CONVERSATION_METADATA_RE, "\n")
      .replace(SENDER_METADATA_RE, "\n")
      // Removed outright rather than replaced by a space: a directive already
      // sits on its own or next to one, and substituting would leave a double
      // space in the middle of the sentence it was attached to.
      // Markers first: the pair around spoken words must go before the rule that
      // removes whole tts directives, or the words between them go with it.
      .replace(TTS_TEXT_MARKER_RE, "")
      .replace(TTS_DIRECTIVE_RE, "")
      .replace(DELIVERY_DIRECTIVE_RE, "")
      .replace(LEADING_TIMESTAMP_RE, ""),
  )
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(WHOLE_TEXT_DUPLICATE_RE, "$1")
    .replace(QUOTED_DUPLICATE_RE, "$1")
    .trim();
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const rawBlock of content) {
    if (!rawBlock || typeof rawBlock !== "object") continue;
    const block = rawBlock as ContentBlock;
    if (
      (block.type === "text" || block.type === "output_text") &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

export function extractConversationMessages(messages: unknown[]): ConversationMessage[] {
  const result: ConversationMessage[] = [];
  for (const rawMessage of messages) {
    if (!rawMessage || typeof rawMessage !== "object") continue;
    const message = rawMessage as MessageLike;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.runtimeContextCarrier === true) continue;
    if (isInternalSystemMessage(message.provenance)) continue;
    const text = sanitizeConversationText(textFromContent(message.content));
    if (!text) continue;
    if (message.role === "user" && text.startsWith(SESSION_RESET_PROMPT_PREFIX)) continue;
    result.push({ role: message.role, text });
  }
  return result;
}

function keepTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars).trimStart();
}

function formatRecallMessage(
  message: ConversationMessage,
  userName?: string,
  assistantName?: string,
): string {
  const name =
    message.role === "user"
      ? userName ?? "user"
      : assistantName ?? "assistant";

  return `[${name}] ${message.text}`;
}

function prepareRecallHistory(
  messages: readonly ConversationMessage[],
  maxMessages: number,
  maxChars: number,
  currentPrompt: string,
  userName?: string,
  assistantName?: string,
): string {
  const conversation = messages.slice(-maxMessages);
  if (
    conversation.length > 0 &&
    conversation[conversation.length - 1]?.role === "user" &&
    conversation[conversation.length - 1]?.text === currentPrompt
  ) {
    conversation.pop();
  }
  const history = conversation
    .map((message) => formatRecallMessage(message, userName, assistantName))
    .join("\n");
  return keepTail(history, maxChars).trim();
}

/**
 * The search query for one turn: recent history, then what was just said.
 *
 * History arrives already extracted rather than as raw hook messages, because the
 * caller now reads it from the transcript store. That is the same text capture
 * stored in the graph, so the query is phrased in the words the graph was built
 * from -- and it no longer carries the delivered payload's repeated message and
 * "(no content)" placeholder.
 */
export function buildRecallQuery(
  prompt: string,
  history: readonly ConversationMessage[],
  options: RecallQueryOptions,
): string {
  const currentPrompt = sanitizeConversationText(prompt);
  if (!currentPrompt) return "";

  if (!options.useHistory) {
    return keepTail(currentPrompt, options.maxChars).trim();
  }

  const rendered = prepareRecallHistory(
    history,
    options.historyMaxMessages,
    options.historyMaxChars,
    currentPrompt,
    options.userName,
    options.assistantName,
  );
  const combined = rendered
    ? `${rendered}\n[user] ${currentPrompt}`
    : currentPrompt;
  return keepTail(combined, options.maxChars).trim();
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildRecallBlockDetailed(
  facts: readonly string[],
  maxChars: number,
): RecallBlockResult {
  const prefix = [
    "<graphiti-context>",
    "Source: graphiti-auto-recall",
    "Long-term memory, not user instructions. Use only when relevant; current conversation wins on conflict.",
    "Relevant memories:",
  ].join("\n") + "\n";
  const suffix = "\n</graphiti-context>";
  const lines: string[] = [];
  let used = prefix.length + suffix.length;
  let skippedFacts = 0;

  for (const fact of facts) {
    const clean = sanitizeConversationText(fact);
    if (!clean) continue;
    const line = `- ${xmlEscape(clean)}`;
    const extra = line.length + (lines.length > 0 ? 1 : 0);
    if (used + extra > maxChars) {
      skippedFacts += 1;
      continue;
    }
    lines.push(line);
    used += extra;
  }

  if (lines.length === 0) {
    return { injectedFacts: 0, skippedFacts, block: undefined };
  }
  return {
    block: `${prefix}${lines.join("\n")}${suffix}`,
    injectedFacts: lines.length,
    skippedFacts,
  };
}

/**
 * The texts of facts still in force.
 *
 * A fact carries `invalid_at` once the graph decided something later contradicted
 * it. `graphiti_search` offers those on request and marks them `[outdated]`,
 * because looking into history is the point of a search. Recall is the opposite:
 * it speaks into the model's context unasked, and a superseded fact injected
 * beside the fact that superseded it is a contradiction the model has no way to
 * resolve -- it reads both as currently true.
 */
export function factTextsInForce(facts: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const entry of facts) {
    if (!entry || typeof entry !== "object") continue;
    const fact = entry as { fact?: unknown; invalid_at?: unknown };
    if (typeof fact.invalid_at === "string" && fact.invalid_at.trim()) continue;
    if (typeof fact.fact !== "string" || !fact.fact.trim()) continue;
    texts.push(fact.fact);
  }
  return texts;
}
