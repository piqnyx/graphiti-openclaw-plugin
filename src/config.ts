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
  recallQueryMaxChars: number;
  recallMaxInjectedChars: number;
  recallUseHistory: boolean;
  recallHistoryMaxMessages: number;
  recallHistoryMaxChars: number;
  logOperations: boolean;
  logLevel: LogLevel;
  logContent: boolean;
  logModelInput: boolean;
  bufferLimit: number;
  bufferTimeout: number;
  excludeSessionPatterns: string[];
  agentTools: boolean;
  communityRebuildHours: number;
  agents: Record<string, AgentActors>;
};

export const DEFAULT_ACTORS: AgentActors = { user: "User", assistant: "Assistant" };

export const DEFAULT_CONFIG: GraphitiPluginConfig = {
  baseUrl: "http://127.0.0.1:8000/mcp/",
  autoCapture: true,
  autoRecall: true,
  requestTimeoutMs: 45_000,
  recallLimit: 8,
  recallQueryMaxChars: 6_000,
  recallMaxInjectedChars: 8_000,
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
  // Defaults reproduce the background/slug-generator filtering that used to be
  // hardcoded. They are ordinary config: override or extend them freely.
  agentTools: true,
  // 0 means "no schedule": the status tool then reports how old the summaries
  // are without inventing a due date it has no way to know.
  communityRebuildHours: 0,
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
    "recallHistoryMaxMessages", "recallHistoryMaxChars", "logOperations", "logLevel",
    "logContent", "logModelInput", "bufferLimit", "bufferTimeout", "excludeSessionPatterns", "agentTools",
    "communityRebuildHours", "agents",
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
    recallQueryMaxChars: integerValue(raw.recallQueryMaxChars, DEFAULT_CONFIG.recallQueryMaxChars, "recallQueryMaxChars", 32, 32_000),
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
    excludeSessionPatterns: excludeSessionPatternsValue(raw.excludeSessionPatterns),
    agentTools: booleanValue(raw.agentTools, DEFAULT_CONFIG.agentTools, "agentTools"),
    communityRebuildHours: integerValue(raw.communityRebuildHours, DEFAULT_CONFIG.communityRebuildHours, "communityRebuildHours", 0, 8_760),
    agents: agentsValue(raw.agents),
  };
}
