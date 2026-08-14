import type { ParticipantConfig, ParticipantRole } from "./config.js";
import type { Buffer, BufferMessage, QueueEntry } from "./buffer.js";

const GRAPHITI_CONTEXT_RE = /<graphiti-context\b[^>]*>[\s\S]*?<\/graphiti-context>/gi;
const OPENVIKING_CONTEXT_RE = /<openviking-context\b[^>]*>[\s\S]*?<\/openviking-context>/gi;
const OPENVIKING_MEMORIES_RE = /<relevant-memories\b[^>]*>[\s\S]*?<\/relevant-memories>/gi;
const CONVERSATION_METADATA_RE =
  /(?:^|\n)\s*(?:Conversation info|Conversation metadata)\s*(?:\([^)]+\))?\s*:\s*```(?:json)?[\s\S]*?```/gi;
const SENDER_METADATA_RE = /(?:^|\n)\s*Sender\s*\([^)]*\)\s*:\s*```(?:json)?[\s\S]*?```/gi;
const LEADING_TIMESTAMP_RE =
  /^\s*\[(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+)?\d{4}[-/]\d{2}[-/]\d{2}[^\]]*\]\s*/i;

export const SLUG_GENERATOR_SESSION_KEY = "***";
export const SESSION_RESET_PROMPT_PREFIX = "A new session was started via /new or /reset";

type ContentBlock = {
  type?: unknown;
  text?: unknown;
};

type MessageLike = {
  role?: unknown;
  content?: unknown;
};

export function stripInjectedContexts(text: string): string {
  return text
    .replace(GRAPHITI_CONTEXT_RE, " ")
    .replace(OPENVIKING_CONTEXT_RE, " ")
    .replace(OPENVIKING_MEMORIES_RE, " ");
}

export function sanitizeConversationText(text: string): string {
  return stripInjectedContexts(text)
    .replace(CONVERSATION_METADATA_RE, "\n")
    .replace(SENDER_METADATA_RE, "\n")
    .replace(LEADING_TIMESTAMP_RE, "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
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

export type CompletedTurn = {
  user: string;
  assistant: string;
};

export function extractCompletedTurn(messages: unknown[]): CompletedTurn | null {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as MessageLike | undefined;
    if (message && message.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return null;

  let finalAssistantIndex = -1;
  for (let i = messages.length - 1; i > lastUserIndex; i -= 1) {
    const message = messages[i] as MessageLike | undefined;
    if (message && message.role === "assistant") {
      finalAssistantIndex = i;
      break;
    }
  }
  if (finalAssistantIndex < 0) return null;

  const userMessage = messages[lastUserIndex] as MessageLike;
  const assistantMessage = messages[finalAssistantIndex] as MessageLike;
  const user = sanitizeConversationText(textFromContent(userMessage.content));
  const assistant = sanitizeConversationText(textFromContent(assistantMessage.content));

  if (!user || !assistant) return null;
  if (user.startsWith(SESSION_RESET_PROMPT_PREFIX)) return null;

  return { user, assistant };
}

export function prepareRecallQuery(text: string, maxChars: number): string {
  const clean = sanitizeConversationText(text);
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, maxChars).trim();
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildRecallBlock(facts: readonly string[], maxChars: number): string | undefined {
  const prefix = "<graphiti-context>\nSource: graphiti-auto-recall\nRelevant Graphiti facts:\n";
  const suffix = "\n</graphiti-context>";
  const lines: string[] = [];
  let used = prefix.length + suffix.length;

  for (const fact of facts) {
    const clean = sanitizeConversationText(fact);
    if (!clean) continue;
    const line = `- ${xmlEscape(clean)}`;
    const extra = line.length + (lines.length > 0 ? 1 : 0);
    if (used + extra > maxChars) continue;
    lines.push(line);
    used += extra;
  }

  if (lines.length === 0) return undefined;
  return `${prefix}${lines.join("\n")}${suffix}`;
}

// ---------------------------------------------------------------------------
// v0.2: канонические имена, алиасы и сборка JSON-эпизода (json-format.md)
// ---------------------------------------------------------------------------

/** Компилирует регулярки алиасов каждого участника один раз при старте. */
export function compileAliasMatchers(
  participants: readonly ParticipantConfig[],
): Map<ParticipantRole, RegExp[]> {
  const map = new Map<ParticipantRole, RegExp[]>();
  for (const p of participants) {
    const matchers: RegExp[] = [];
    for (const alias of p.aliases) {
      try {
        // Алиас трактуется как литеральная фраза; экранируем спецсимволы,
        // чтобы пользователь писал обычные имена/слова, а не регулярки.
        matchers.push(new RegExp(escapeRegExp(alias), "gi"));
      } catch {
        // Некорректный алиас пропускаем при компиляции — конфиг уже валидирован.
      }
    }
    map.set(p.role, matchers);
  }
  return map;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Нормализует текст сообщения: заменяет алиасы всех участников на канонические имена. */
export function normalizeText(
  text: string,
  matchers: Map<ParticipantRole, RegExp[]>,
  participants: readonly ParticipantConfig[],
): string {
  let result = text;
  for (const p of participants) {
    const regexps = matchers.get(p.role);
    if (!regexps) continue;
    for (const re of regexps) {
      result = result.replace(re, p.name);
    }
  }
  return result;
}

export type EpisodeJson = {
  participants: Record<ParticipantRole, string>;
  messages: BufferMessage[];
};

/** Собирает JSON-эпизод из очереди-записи (json-format.md). */
export function buildEpisodeJson(
  entry: QueueEntry,
  participants: readonly ParticipantConfig[],
  aliasMatchers: Map<ParticipantRole, RegExp[]>,
): EpisodeJson {
  const names: Record<ParticipantRole, string> = {
    user: "user",
    assistant: "assistant",
  };
  for (const p of participants) {
    names[p.role] = p.name;
  }

  const messages = entry.buffer.messages.map((m) => ({
    role: m.role,
    text: normalizeText(m.text, aliasMatchers, participants),
  }));

  return { participants: names, messages };
}

/**
 * Полная карта участников: role -> { name, aliases }.
 * Удобно для движка/логов.
 */
export function participantMap(
  participants: readonly ParticipantConfig[],
): Record<ParticipantRole, { name: string; aliases: string[] }> {
  const map: Record<ParticipantRole, { name: string; aliases: string[] }> = {
    user: { name: "user", aliases: [] },
    assistant: { name: "assistant", aliases: [] },
  };
  for (const p of participants) map[p.role] = { name: p.name, aliases: p.aliases };
  return map;
}

// ---------------------------------------------------------------------------
// (удалено) formatTurnsForEpisode — заменено на buildEpisodeJson (v0.2)
// ---------------------------------------------------------------------------
