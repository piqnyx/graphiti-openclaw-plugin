#!/usr/bin/env node
/**
 * The recall command: what Graphiti would put before a prompt on a turn, for a caller
 * outside the gateway. The news digest reads every post against memory the way Eva's
 * own turn would (digest PLAN.md, stage 2), so this runs the very functions the
 * before_prompt_build hook runs -- recallQuery and recallFacts -- with the plugin's
 * settings read from the gateway's own openclaw.json and parsed the plugin's way.
 * The prompt is taken as a turn with no conversation before it.
 *
 *   node dist/recall-cli.js [--config ~/.openclaw/openclaw.json] < request.json
 *
 * The request on stdin: {"agentId": "main", "prompt": "...", "digestMarkers"?: [...]}. On
 * stdout, one JSON object: {"query", "block", "facts", "rankedBy", "scores"} -- `block` is
 * null when the prompt leaves nothing to search for or nothing was found -- and, when
 * digestMarkers are given, "origins": per fact "digest", "talk" or null (factOrigins). The plugin's own log lines
 * go to stderr. A failure exits 1 with the reason on stderr and nothing on stdout.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseConfig } from "./config.js";
import { requireAgentId } from "./identity.js";
import { createGraphitiLogger } from "./logging.js";
import { GraphitiMcpClient } from "./mcp-client.js";
import { compileMessageRules } from "./message-rules.js";
import { factOrigins, type FactOrigin } from "./recall-expand.js";
import { recallFacts, recallQuery } from "./recall.js";
import { sanitizeConversationText, SESSION_RESET_PROMPT_PREFIX } from "./text.js";
import type { PluginLogger } from "./types.js";

const PLUGIN_ID = "graphiti-openclaw-plugin";

export type RecallCommandResult = {
  query: string;
  block: string | null;
  facts: string[];
  rankedBy: string | null;
  scores: (number | null)[];
  origins?: FactOrigin[];
};

export async function runRecallCommand(params: {
  gatewayConfig: unknown;
  request: unknown;
  logSink: PluginLogger;
}): Promise<RecallCommandResult> {
  const entries = (params.gatewayConfig as { plugins?: { entries?: Record<string, { config?: unknown }> } })
    ?.plugins?.entries;
  const entry = entries?.[PLUGIN_ID];
  if (!entry) throw new Error(`the gateway config has no plugins.entries["${PLUGIN_ID}"]`);
  const cfg = parseConfig(entry.config ?? {});

  const request = (params.request ?? {}) as { agentId?: unknown; prompt?: unknown; digestMarkers?: unknown };
  if (request.agentId === undefined) throw new Error("the request has no agentId");
  const agentId = requireAgentId(request.agentId);
  if (typeof request.prompt !== "string") throw new Error("the request has no prompt string");
  const markers = Array.isArray(request.digestMarkers)
    ? request.digestMarkers.filter((marker): marker is string => typeof marker === "string" && marker.trim() !== "")
    : [];

  const nothing: RecallCommandResult = { query: "", block: null, facts: [], rankedBy: null, scores: [] };
  const currentPrompt = sanitizeConversationText(request.prompt);
  if (!currentPrompt || currentPrompt.startsWith(SESSION_RESET_PROMPT_PREFIX)) return nothing;
  const query = recallQuery(cfg, agentId, currentPrompt, [], compileMessageRules(cfg.messageRules));
  if (!query) return nothing;

  const logger = createGraphitiLogger(params.logSink, cfg);
  const client = new GraphitiMcpClient(cfg.baseUrl, cfg.requestTimeoutMs);
  try {
    const found = await recallFacts({ client, cfg, logger, agentId, query, focus: currentPrompt });
    const result: RecallCommandResult = {
      query,
      block: found.recallBlock.block ?? null,
      facts: found.factTexts,
      rankedBy: found.rankedBy,
      scores: found.inForce.map((fact) => (typeof fact.score === "number" ? fact.score : null)),
    };
    if (markers.length > 0) result.origins = await factOrigins(client, agentId, found.inForce, markers);
    return result;
  } finally {
    client.close();
  }
}

function argument(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

async function main(argv: readonly string[]): Promise<number> {
  const configPath = argument(argv, "--config") ?? join(homedir(), ".openclaw", "openclaw.json");
  const toStderr = (message: string) => process.stderr.write(`${message}\n`);
  try {
    const gatewayConfig = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    const request = JSON.parse(readFileSync(0, "utf8")) as unknown;
    const result = await runRecallCommand({
      gatewayConfig,
      request,
      logSink: { debug: toStderr, info: toStderr, warn: toStderr, error: toStderr },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    toStderr(`graphiti recall: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
