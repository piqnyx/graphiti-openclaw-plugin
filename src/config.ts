export type GraphitiPluginConfig = {
  baseUrl: string;
  autoCapture: boolean;
  autoRecall: boolean;
  captureBatchTurns: number;
  captureBatchIdleFlushSeconds: number;
  requestTimeoutMs: number;
  recallLimit: number;
  recallQueryMaxChars: number;
  recallMaxInjectedChars: number;
  captureMaxChars: number;
  logOperations: boolean;
};

export const DEFAULT_CONFIG: GraphitiPluginConfig = {
  baseUrl: "http://127.0.0.1:8000/mcp/",
  autoCapture: true,
  autoRecall: true,
  captureBatchTurns: 10,
  captureBatchIdleFlushSeconds: 300,
  requestTimeoutMs: 45_000,
  recallLimit: 6,
  recallQueryMaxChars: 2_000,
  recallMaxInjectedChars: 4_000,
  captureMaxChars: 12_000,
  logOperations: true,
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

export function parseConfig(input: unknown): GraphitiPluginConfig {
  const raw = asObject(input);
  const allowed = new Set<keyof GraphitiPluginConfig>([
    "baseUrl",
    "autoCapture",
    "autoRecall",
    "captureBatchTurns",
    "captureBatchIdleFlushSeconds",
    "requestTimeoutMs",
    "recallLimit",
    "recallQueryMaxChars",
    "recallMaxInjectedChars",
    "captureMaxChars",
    "logOperations",
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
    captureBatchTurns: integerValue(
      raw.captureBatchTurns,
      DEFAULT_CONFIG.captureBatchTurns,
      "captureBatchTurns",
      1,
      1_000,
    ),
    captureBatchIdleFlushSeconds: integerValue(
      raw.captureBatchIdleFlushSeconds,
      DEFAULT_CONFIG.captureBatchIdleFlushSeconds,
      "captureBatchIdleFlushSeconds",
      1,
      86_400,
    ),
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
    captureMaxChars: integerValue(
      raw.captureMaxChars,
      DEFAULT_CONFIG.captureMaxChars,
      "captureMaxChars",
      256,
      200_000,
    ),
    logOperations: booleanValue(raw.logOperations, DEFAULT_CONFIG.logOperations, "logOperations"),
  };
}
