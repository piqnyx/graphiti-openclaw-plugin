export type LogLevel = "error" | "warn" | "info" | "debug";

export type ParticipantRole = "user" | "assistant";

export type ParticipantConfig = {
  role: ParticipantRole;
  name: string;
  aliases: string[];
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
  // v0.2: buffer / queue
  bufferLimit: number;
  bufferTimeout: number;
  participants: ParticipantConfig[];
};

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
  bufferLimit: 50,
  bufferTimeout: 900,
  participants: [
    { role: "user", name: "Вит", aliases: [] },
    { role: "assistant", name: "Краб", aliases: [] },
  ],
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

/**
 * Participants: ровно один `user` и один `assistant`, с непустыми именами и
 * опциональными массивами алиасов-регулярок.
 */
function participantsValue(raw: unknown): ParticipantConfig[] {
  if (raw === undefined) return DEFAULT_CONFIG.participants;
  if (!Array.isArray(raw)) throw new Error("participants must be an array");

  const seen = new Set<ParticipantRole>();
  const result: ParticipantConfig[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("each participant must be an object");
    }
    const p = item as Record<string, unknown>;

    const role = p.role;
    if (role !== "user" && role !== "assistant") {
      throw new Error('participant role must be "user" or "assistant"');
    }
    if (seen.has(role)) {
      throw new Error(`duplicate participant role: ${role}`);
    }

    const name = p.name;
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(`participant ${role} name must be a non-empty string`);
    }

    let aliases: string[] = [];
    if (p.aliases !== undefined) {
      if (!Array.isArray(p.aliases)) {
        throw new Error(`participant ${role} aliases must be an array of strings`);
      }
      aliases = p.aliases.map((alias, idx) => {
        if (typeof alias !== "string" || alias.trim() === "") {
          throw new Error(`participant ${role} alias at index ${idx} must be a non-empty string`);
        }
        return alias.trim();
      });
    }

    seen.add(role);
    result.push({ role, name: name.trim(), aliases });
  }

  if (!seen.has("user")) throw new Error("participants must include a user role");
  if (!seen.has("assistant")) throw new Error("participants must include an assistant role");

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
    "participants",
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
      30,
      1_000,
    ),
    bufferTimeout: integerValue(
      raw.bufferTimeout,
      DEFAULT_CONFIG.bufferTimeout,
      "bufferTimeout",
      30,
      7 * 24 * 60 * 60,
    ),
    participants: participantsValue(raw.participants),
  };
}
