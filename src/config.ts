export type LogLevel = "error" | "warn" | "info" | "debug";

/**
 * Канонические имена акторов одного агента.
 * `user` — человек, `assistant` — его бот. Без алиасов-регулярок:
 * имена служат только для participants в JSON-эпизоде Graphiti, текст
 * сообщений НЕ переписывается (никакого поедания слогов/мусора).
 */
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
  logOperations: boolean;
  logLevel: LogLevel;
  logContent: boolean;
  // v0.2: buffer / queue  (bufferTimeout — в секундах)
  bufferLimit: number;
  bufferTimeout: number;
  // v0.2: канонические имена акторов ПО АГЕНТАМ (мультиагент).
  // Ключ — agentId (main, igor, red, orange...), значение — имена человека и бота.
  agents: Record<string, AgentActors>;
  // v0.2: natural-language надстройка над дефолтным extract_json промптом
  // (custom_extraction_instructions в add_memory). Пусто = без надстройки.
  customExtractionInstructions: string;
};

export const DEFAULT_ACTORS: AgentActors = { user: "User", assistant: "Assistant" };

export const DEFAULT_CONFIG: GraphitiPluginConfig = {
  baseUrl: "http://127.0.0.1:8000/mcp/",
  autoCapture: true,
  autoRecall: true,
  requestTimeoutMs: 45_000,
  recallLimit: 6,
  recallQueryMaxChars: 2_000,
  recallMaxInjectedChars: 4_000,
  logOperations: true,
  logLevel: "info",
  logContent: false,
  // v0.2: buffer / queue  (bufferTimeout — в секундах)
  bufferLimit: 4,
  bufferTimeout: 900,
  agents: {
    main: { user: "Вит", assistant: "Краб" },
  },
  customExtractionInstructions: "",
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

function stringValue(raw: unknown, fallback: string, name: string): string {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string") throw new Error(`${name} must be a string`);
  return raw;
}

function integerValue(
  raw: unknown,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
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

/**
 * Агенты: объект { agentId: { user: string, assistant: string } }.
 * Алиасов-регулярок нет — только канонические имена человека и бота.
 */
function agentsValue(raw: unknown): Record<string, AgentActors> {
  if (raw === undefined) return DEFAULT_CONFIG.agents;
  const obj = asObject(raw);
  const result: Record<string, AgentActors> = {};

  for (const [agentId, value] of Object.entries(obj)) {
    if (agentId.trim() === "") {
      throw new Error("agents key (agentId) must be a non-empty string");
    }
    const entry = asObject(value);
    const allowedEntry = new Set(["user", "assistant"]);
    for (const key of Object.keys(entry)) {
      if (!allowedEntry.has(key)) {
        throw new Error(`agents[${agentId}] contains unknown key: ${key}`);
      }
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
    "baseUrl",
    "autoCapture",
    "autoRecall",
    "requestTimeoutMs",
    "recallLimit",
    "recallQueryMaxChars",
    "recallMaxInjectedChars",
    "logOperations",
    "logLevel",
    "logContent",
    "bufferLimit",
    "bufferTimeout",
    "agents",
    "customExtractionInstructions",
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
    requestTimeoutMs: integerValue(
      raw.requestTimeoutMs,
      DEFAULT_CONFIG.requestTimeoutMs,
      "requestTimeoutMs",
      1_000,
      300_000,
    ),
    recallLimit: integerValue(raw.recallLimit, DEFAULT_CONFIG.recallLimit, "recallLimit", 1, 100),
    recallQueryMaxChars: integerValue(
      raw.recallQueryMaxChars,
      DEFAULT_CONFIG.recallQueryMaxChars,
      "recallQueryMaxChars",
      32,
      32_000,
    ),
    recallMaxInjectedChars: integerValue(
      raw.recallMaxInjectedChars,
      DEFAULT_CONFIG.recallMaxInjectedChars,
      "recallMaxInjectedChars",
      128,
      64_000,
    ),
    logOperations: booleanValue(raw.logOperations, DEFAULT_CONFIG.logOperations, "logOperations"),
    logLevel: logLevelValue(raw.logLevel),
    logContent: booleanValue(raw.logContent, DEFAULT_CONFIG.logContent, "logContent"),
    bufferLimit: integerValue(
      raw.bufferLimit,
      DEFAULT_CONFIG.bufferLimit,
      "bufferLimit",
      4,
      1_000,
    ),
    bufferTimeout: integerValue(
      raw.bufferTimeout,
      DEFAULT_CONFIG.bufferTimeout,
      "bufferTimeout",
      120,
      7 * 24 * 60 * 60,
    ),
    agents: agentsValue(raw.agents),
    customExtractionInstructions: stringValue(
      raw.customExtractionInstructions,
      DEFAULT_CONFIG.customExtractionInstructions,
      "customExtractionInstructions",
    ),
  };
}
