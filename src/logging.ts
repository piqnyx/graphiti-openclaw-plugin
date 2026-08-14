import type { GraphitiPluginConfig, LogLevel } from "./config.js";
import type { PluginLogger } from "./types.js";

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

type LogFields = Record<string, unknown>;
type ContentFields = Record<string, string | readonly string[]>;

function renderValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function renderMessage(event: string, fields: LogFields): string {
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${renderValue(value)}`)
    .join(" ");
  return suffix ? `graphiti: event=${event} ${suffix}` : `graphiti: event=${event}`;
}

export type GraphitiLogger = {
  error: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  info: (event: string, fields?: LogFields) => void;
  debug: (event: string, fields?: LogFields) => void;
  debugContent: (event: string, fields: LogFields, content: ContentFields) => void;
};

export function createGraphitiLogger(
  sink: PluginLogger,
  cfg: Pick<GraphitiPluginConfig, "logOperations" | "logLevel" | "logContent">,
): GraphitiLogger {
  const enabled = (level: LogLevel): boolean => {
    if (!cfg.logOperations && (level === "info" || level === "debug")) return false;
    return LEVEL_RANK[level] <= LEVEL_RANK[cfg.logLevel];
  };

  const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    if (!enabled(level)) return;
    const message = renderMessage(event, fields);
    if (level === "debug") {
      const debugSink = sink.debug ?? sink.info;
      debugSink(message);
      return;
    }
    if (level === "error") sink.error(message);
    else if (level === "warn") sink.warn(message);
    else sink.info(message);
  };

  return {
    error: (event, fields) => emit("error", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    info: (event, fields) => emit("info", event, fields),
    debug: (event, fields) => emit("debug", event, fields),
    debugContent: (event, fields, content) => {
      // Контент-логи пишем на INFO, а не DEBUG: при `logContent: true` юзер явно
      // хочет видеть, что реально уходит (payload, recall-инъекции) — а DEBUG
      // во многих сетапах (journald) не доходит до лога плагина. INFO виден всегда.
      if (!cfg.logContent) return;
      if (!cfg.logOperations) return; // контент — тоже операция, уважаем отключение
      if (LEVEL_RANK[cfg.logLevel] < LEVEL_RANK.info) return; // ниже info — не пишем
      emit("info", event, { ...fields, ...content });
    },
  };
}
