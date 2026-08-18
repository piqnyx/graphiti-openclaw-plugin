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
const CONVERSATION_METADATA_RE =
  /(?:^|\n)\s*(?:Conversation info|Conversation metadata)\s*(?:\([^)]+\))?\s*:\s*```(?:json)?[\s\S]*?```/gi;
const SENDER_METADATA_RE = /(?:^|\n)\s*Sender\s*\([^)]*\)\s*:\s*```(?:json)?[\s\S]*?```/gi;
/**
 * OpenClaw prefixes machine transcription with a provenance marker, e.g.
 * `[Audio transcript (machine-generated, untrusted)]: "текст"`. The marker exists
 * for the live prompt; storing it would put the wrapper itself into the graph and
 * let extraction mint entities out of it.
 */
const TRANSCRIPT_PREFIX_RE = /^\s*\[[^\]\n]{0,160}transcript[^\]\n]{0,160}\]\s*:\s*/i;
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
const TTS_DIRECTIVE_RE = /\[\[tts:(?!text\]\])[^\]]*\]\]/gi;
const TTS_TEXT_MARKER_RE = /\[\[\/?tts:text\]\]/gi;
const AUDIO_AS_VOICE_RE = /\[\[audio_as_voice\]\]/gi;
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
};

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

/** Remove the transcription provenance marker and unwrap the quoted transcript. */
function stripTranscriptWrapper(text: string): string {
  const withoutMarker = text.replace(TRANSCRIPT_PREFIX_RE, "");
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
    stripInjectedContexts(text)
      .replace(OPENCLAW_INTERNAL_CONTEXT_RE, "")
      .replace(OPENCLAW_UNCLOSED_CONTEXT_RE, "")
      .replace(CONVERSATION_METADATA_RE, "\n")
      .replace(SENDER_METADATA_RE, "\n")
      // Removed outright rather than replaced by a space: a directive already
      // sits on its own or next to one, and substituting would leave a double
      // space in the middle of the sentence it was attached to.
      .replace(TTS_DIRECTIVE_RE, "")
      .replace(TTS_TEXT_MARKER_RE, "")
      .replace(AUDIO_AS_VOICE_RE, "")
      .replace(LEADING_TIMESTAMP_RE, ""),
  )
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(WHOLE_TEXT_DUPLICATE_RE, "$1");
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
  messages: unknown[],
  maxMessages: number,
  maxChars: number,
  currentPrompt: string,
  userName?: string,
  assistantName?: string,
): string {
  const conversation = extractConversationMessages(messages).slice(-maxMessages);
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

export function buildRecallQuery(
  prompt: string,
  messages: unknown[],
  options: RecallQueryOptions,
): string {
  const currentPrompt = sanitizeConversationText(prompt);
  if (!currentPrompt) return "";

  if (!options.useHistory) {
    return keepTail(currentPrompt, options.maxChars).trim();
  }

  const history = prepareRecallHistory(
    messages,
    options.historyMaxMessages,
    options.historyMaxChars,
    currentPrompt,
    options.userName,
    options.assistantName,
  );
  const combined = history
    ? `${history}\n[user] ${currentPrompt}`
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
