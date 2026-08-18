import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SPOOL_DIR_NAME = "graphiti-openclaw-plugin";
const LEGACY_SPOOL_FILE_NAME = "capture-spool.json";

function resolveUserPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

export function resolveOpenClawStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  return override ? resolveUserPath(override) : join(homedir(), ".openclaw");
}

/**
 * Path used only to detect the retired monolithic capture spool.
 *
 * The live capture implementation uses the segmented durable journal/FIFO under
 * durable-capture-v1. If this legacy file exists, startup fails closed so queued
 * data from the old architecture is never silently ignored or mixed with the new
 * chronology. Migration/reset is an explicit operator action, not hidden runtime
 * behavior.
 */
export function resolveCaptureSpoolPath(): string {
  return join(resolveOpenClawStateDir(), SPOOL_DIR_NAME, LEGACY_SPOOL_FILE_NAME);
}
