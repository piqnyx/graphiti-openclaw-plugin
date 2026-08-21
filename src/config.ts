import { MIN_BUFFER_TIMEOUT_SEC } from "./capture-constants.js";
import { compileSessionPattern } from "./session-filter.js";

export { MIN_BUFFER_TIMEOUT_SEC } from "./capture-constants.js";

export type LogLevel = "error" | "warn" | "info" | "debug";

export type AgentActors = {
  user: string;
  assistant: string;
};

export type GraphitiPluginConfig = {
  baseUrl: string;
  autoCapture: boolean;
  autoRecall: boolean;
  requestTimeoutMs: number;
  recallLimit: number;
  /**
   * How many of the returned facts are shown with the conversation behind them.
   *
   * Zero keeps recall as a list of sentences. Each expansion costs its own window
   * twice over, so the ceiling on what recall can inject is this times twice
   * recallExpandChars -- no third setting is needed to bound it.
   */
  recallExpandTop: number;
  /** Characters of conversation kept on each side of the point a fact came from. */
  recallExpandChars: number;
  recallQueryMaxChars: number;
  recallMaxInjectedChars: number;
  /**
   * How many candidates recall examines before choosing `recallLimit` of them.
   *
   * Zero keeps the two the same number, which is what they were: each search
   * method fetches twice the limit, so asking for eight facts looked at sixteen
   * candidates and nothing below that depth could be reached by asking
   * differently. Measured on a live graph, a question about a repository
   * returned twenty-five facts about shell utilities while the facts about that
   * repository sat unreachable at any requested size.
   */
  recallPool: number;
  /**
   * Score the candidates with a cross-encoder against the message just sent,
   * rather than fusing the search methods by rank.
   *
   * Rank fusion has no notion of "none of these are relevant": its top result
   * scores the same whether the graph holds the answer or holds cafe dishes. A
   * cross-encoder scores each candidate against the question, which is what
   * makes both a floor and an empty answer possible.
   */
  recallRerank: boolean;
  /**
   * Below this, a fact is not injected. Null keeps whatever the search recipe
   * declares.
   *
   * The scale belongs to the reranker: a bge cross-encoder returns logits either
   * side of zero, while a Cohere-shaped one returns 0..1. Measured with the
   * latter on this graph, a question's one right answer scored 0.146 with the
   * next candidate at 0.046, and a question the graph could not answer scored
   * everything below 0.027.
   */
  recallMinScore: number | null;
  /**
   * The floor for a second pass scored against the recent conversation, taken
   * only when the first pass admitted nothing. Null means the message decides
   * alone.
   *
   * A message like "далеко это от меня вообще?" carries no word to rank by:
   * scoring by it put every fact within a hundredth of every other, while the
   * conversation knew that "это" was Poti and scored it 0.437. The scales
   * differ, hence a floor of its own -- a transcript resembles everything a
   * little, so its numbers run several times higher.
   */
  /**
   * How much a candidate's score against the conversation counts when the remark
   * itself cannot judge it. Zero leaves that second pass unrun, which is the
   * default for the same reason the other three are off: an untouched deployment
   * sends the request it sent before any of this existed.
   */
  recallContextWeight: number;
  recallUseHistory: boolean;
  recallHistoryMaxMessages: number;
  recallHistoryMaxChars: number;
  logOperations: boolean;
  logLevel: LogLevel;
  logContent: boolean;
  logModelInput: boolean;
  bufferLimit: number;
  bufferTimeout: number;
  /**
   * Where an agent's transcript store lives; `{agentId}` is substituted.
   *
   * Configurable because the capture reads the gateway's own database, and a
   * deployment that moves ~/.openclaw must be able to say so without a rebuild.
   */
  agentDbPath: string;
  /**
   * Skip whatever a session already holds the first time it is seen.
   *
   * Off, because a conversation that starts now is written and read in the same
   * turn: skipping "existing history" would drop the opening exchange of every new
   * dialog. Turn it on for the one case that needs it -- the plugin's own state was
   * discarded while the memory it fed still holds that history, where reading from
   * the beginning would duplicate every episode instead of recovering anything.
   */
  adoptExistingHistoryOnFirstSight: boolean;
  excludeSessionPatterns: string[];
  agentTools: boolean;
  browseChars: number;
  browseMaxChars: number;
  browseMaxEpisodes: number;
  browseMaxTotalChars: number;
  agents: Record<string, AgentActors>;
};

export const DEFAULT_ACTORS: AgentActors = { user: "User", assistant: "Assistant" };

export const DEFAULT_CONFIG: GraphitiPluginConfig = {
  baseUrl: "http://127.0.0.1:8000/mcp/",
  autoCapture: true,
  autoRecall: true,
  requestTimeoutMs: 45_000,
  recallLimit: 8,
  recallExpandTop: 2,
  recallExpandChars: 512,
  recallQueryMaxChars: 6_000,
  recallMaxInjectedChars: 8_000,
  recallPool: 0,
  recallRerank: false,
  recallMinScore: null,
  recallContextWeight: 0,
  recallUseHistory: true,
  recallHistoryMaxMessages: 6,
  recallHistoryMaxChars: 4_000,
  logOperations: true,
  logLevel: "info",
  logContent: false,
  // Off by default: the assembled model input is enormous and only useful when
  // hunting a specific prompt-assembly question.
  logModelInput: false,
  bufferLimit: 4,
  bufferTimeout: 900,
  agentDbPath: "",
  adoptExistingHistoryOnFirstSight: false,
  // Defaults reproduce the background/slug-generator filtering that used to be
  // hardcoded. They are ordinary config: override or extend them freely.
  agentTools: true,
  // Generous on purpose: reading the real conversation is the expensive half of
  // remembering well, and the host manages the context budget. The ceilings are
  // there to stop an absurd request, not to economise.
  browseChars: 16_000,
  browseMaxChars: 32_000,
  browseMaxEpisodes: 10,
  browseMaxTotalChars: 120_000,
  excludeSessionPatterns: [
    ":cron:",
    ":heartbeat:",
    ":subagent:",
    "^cron$",
    "^heartbeat$",
    "^\\*\\*\\*$",
    // OpenClaw's own probes: a model/setup check is a machine talking to itself
    // to verify a configuration, not a conversation. One of these wrote a whole
    // saga into a live graph before it was noticed, which is exactly the damage
    // this list exists to prevent.
    ":setup-inference:",
    "incognito-probe",
  ],
  agents: {
    main: { user: "Вит", assistant: "Краб" },
  },
};

function asObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("plugin config must be an object");
  }
  return value as Record<string, unknown>;
}

function booleanValue(raw: unknown, fallback: boolean, name: string): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== "boolean") throw new Error(`${name} must be a boolean`);
  return raw;
}

function integerValue(raw: unknown, fallback: number, name: string, min: number, max: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
  return raw;
}

/** A bounded fraction. Unlike a threshold, absent means the default, not "no value". */
function fractionValue(raw: unknown, fallback: number, name: string, min: number, max: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return raw;
}

/** A threshold, or nothing. Absent and null differ from zero: zero is a floor. */
function optionalNumberValue(raw: unknown, name: string): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(`${name} must be a finite number or null`);
  }
  return raw;
}

function logLevelValue(raw: unknown): LogLevel {
  if (raw === undefined) return DEFAULT_CONFIG.logLevel;
  if (raw === "error" || raw === "warn" || raw === "info" || raw === "debug") return raw;
  throw new Error('logLevel must be one of "error", "warn", "info", "debug"');
}

function baseUrlValue(raw: unknown): string {
  if (raw === undefined) return DEFAULT_CONFIG.baseUrl;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("baseUrl must be a non-empty string");
  }
  const url = new URL(raw.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  return url.toString();
}

function nonEmptyName(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${what} must be a non-empty string`);
  }
  return value.trim();
}

const MAX_EXCLUDE_PATTERNS = 64;
const MAX_EXCLUDE_PATTERN_LENGTH = 512;

function excludeSessionPatternsValue(raw: unknown): string[] {
  if (raw === undefined) return [...DEFAULT_CONFIG.excludeSessionPatterns];
  if (!Array.isArray(raw)) throw new Error("excludeSessionPatterns must be an array of strings");
  if (raw.length > MAX_EXCLUDE_PATTERNS) {
    throw new Error(`excludeSessionPatterns accepts at most ${MAX_EXCLUDE_PATTERNS} patterns`);
  }
  return raw.map((pattern, index) => {
    if (typeof pattern !== "string" || pattern.trim() === "") {
      throw new Error(`excludeSessionPatterns[${index}] must be a non-empty string`);
    }
    if (pattern.length > MAX_EXCLUDE_PATTERN_LENGTH) {
      throw new Error(
        `excludeSessionPatterns[${index}] must be at most ${MAX_EXCLUDE_PATTERN_LENGTH} characters`,
      );
    }
    const trimmed = pattern.trim();
    try {
      compileSessionPattern(trimmed);
    } catch (error) {
      throw new Error(
        `excludeSessionPatterns[${index}] is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return trimmed;
  });
}

function agentsValue(raw: unknown): Record<string, AgentActors> {
  if (raw === undefined) return DEFAULT_CONFIG.agents;
  const obj = asObject(raw);
  const result: Record<string, AgentActors> = {};

  for (const [agentId, value] of Object.entries(obj)) {
    if (agentId.trim() === "") throw new Error("agents key (agentId) must be a non-empty string");
    const entry = asObject(value);
    const allowedEntry = new Set(["user", "assistant"]);
    for (const key of Object.keys(entry)) {
      if (!allowedEntry.has(key)) throw new Error(`agents[${agentId}] contains unknown key: ${key}`);
    }
    result[agentId] = {
      user: nonEmptyName(entry.user, `agents[${agentId}].user`),
      assistant: nonEmptyName(entry.assistant, `agents[${agentId}].assistant`),
    };
  }

  return result;
}

export function parseConfig(input: unknown): GraphitiPluginConfig {
  const raw = asObject(input);
  const allowed = new Set<keyof GraphitiPluginConfig>([
    "baseUrl", "autoCapture", "autoRecall", "requestTimeoutMs", "recallLimit",
    "recallQueryMaxChars", "recallMaxInjectedChars", "recallUseHistory",
    "recallPool", "recallRerank", "recallMinScore", "recallContextWeight",
    "recallExpandTop", "recallExpandChars",
    "recallHistoryMaxMessages", "recallHistoryMaxChars", "logOperations", "logLevel",
    "logContent", "logModelInput", "bufferLimit", "bufferTimeout", "agentDbPath", "adoptExistingHistoryOnFirstSight", "excludeSessionPatterns", "agentTools",
    "browseChars", "browseMaxChars", "browseMaxEpisodes", "browseMaxTotalChars", "agents",
  ]);

  for (const key of Object.keys(raw)) {
    if (!allowed.has(key as keyof GraphitiPluginConfig)) {
      throw new Error(`unknown plugin config key: ${key}`);
    }
  }

  return {
    baseUrl: baseUrlValue(raw.baseUrl),
    autoCapture: booleanValue(raw.autoCapture, DEFAULT_CONFIG.autoCapture, "autoCapture"),
    autoRecall: booleanValue(raw.autoRecall, DEFAULT_CONFIG.autoRecall, "autoRecall"),
    requestTimeoutMs: integerValue(raw.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, "requestTimeoutMs", 1_000, 300_000),
    recallLimit: integerValue(raw.recallLimit, DEFAULT_CONFIG.recallLimit, "recallLimit", 1, 100),
    recallExpandTop: integerValue(raw.recallExpandTop, DEFAULT_CONFIG.recallExpandTop, "recallExpandTop", 0, 100),
    recallExpandChars: integerValue(raw.recallExpandChars, DEFAULT_CONFIG.recallExpandChars, "recallExpandChars", 64, 65_536),
    recallQueryMaxChars: integerValue(raw.recallQueryMaxChars, DEFAULT_CONFIG.recallQueryMaxChars, "recallQueryMaxChars", 32, 32_000),
    recallPool: integerValue(raw.recallPool, DEFAULT_CONFIG.recallPool, "recallPool", 0, 500),
    recallRerank: booleanValue(raw.recallRerank, DEFAULT_CONFIG.recallRerank, "recallRerank"),
    recallMinScore: optionalNumberValue(raw.recallMinScore, "recallMinScore"),
    recallContextWeight: fractionValue(raw.recallContextWeight, DEFAULT_CONFIG.recallContextWeight, "recallContextWeight", 0, 1),
    recallMaxInjectedChars: integerValue(raw.recallMaxInjectedChars, DEFAULT_CONFIG.recallMaxInjectedChars, "recallMaxInjectedChars", 128, 64_000),
    recallUseHistory: booleanValue(raw.recallUseHistory, DEFAULT_CONFIG.recallUseHistory, "recallUseHistory"),
    recallHistoryMaxMessages: integerValue(raw.recallHistoryMaxMessages, DEFAULT_CONFIG.recallHistoryMaxMessages, "recallHistoryMaxMessages", 1, 100),
    recallHistoryMaxChars: integerValue(raw.recallHistoryMaxChars, DEFAULT_CONFIG.recallHistoryMaxChars, "recallHistoryMaxChars", 128, 32_000),
    logOperations: booleanValue(raw.logOperations, DEFAULT_CONFIG.logOperations, "logOperations"),
    logLevel: logLevelValue(raw.logLevel),
    logContent: booleanValue(raw.logContent, DEFAULT_CONFIG.logContent, "logContent"),
    logModelInput: booleanValue(raw.logModelInput, DEFAULT_CONFIG.logModelInput, "logModelInput"),
    bufferLimit: integerValue(raw.bufferLimit, DEFAULT_CONFIG.bufferLimit, "bufferLimit", 1, 1_000),
    bufferTimeout: integerValue(raw.bufferTimeout, DEFAULT_CONFIG.bufferTimeout, "bufferTimeout", MIN_BUFFER_TIMEOUT_SEC, 7 * 24 * 60 * 60),
    agentDbPath: typeof raw.agentDbPath === "string" ? raw.agentDbPath.trim() : DEFAULT_CONFIG.agentDbPath,
    adoptExistingHistoryOnFirstSight: booleanValue(
      raw.adoptExistingHistoryOnFirstSight,
      DEFAULT_CONFIG.adoptExistingHistoryOnFirstSight,
      "adoptExistingHistoryOnFirstSight",
    ),
    excludeSessionPatterns: excludeSessionPatternsValue(raw.excludeSessionPatterns),
    agentTools: booleanValue(raw.agentTools, DEFAULT_CONFIG.agentTools, "agentTools"),
    browseChars: integerValue(raw.browseChars, DEFAULT_CONFIG.browseChars, "browseChars", 128, 200_000),
    browseMaxChars: integerValue(raw.browseMaxChars, DEFAULT_CONFIG.browseMaxChars, "browseMaxChars", 128, 200_000),
    browseMaxEpisodes: integerValue(raw.browseMaxEpisodes, DEFAULT_CONFIG.browseMaxEpisodes, "browseMaxEpisodes", 1, 50),
    browseMaxTotalChars: integerValue(raw.browseMaxTotalChars, DEFAULT_CONFIG.browseMaxTotalChars, "browseMaxTotalChars", 1_000, 1_000_000),
    agents: agentsValue(raw.agents),
  };
}
