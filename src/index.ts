import { AgentTurnBuffer } from "./buffer.js";
import { parseConfig } from "./config.js";
import { requireAgentId } from "./identity.js";
import { GraphitiMcpClient } from "./mcp-client.js";
import {
  buildRecallBlock,
  extractCompletedTurn,
  formatTurnsForEpisode,
  prepareRecallQuery,
  SESSION_RESET_PROMPT_PREFIX,
  SLUG_GENERATOR_SESSION_KEY,
} from "./text.js";
import type {
  AgentEndEvent,
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
  HookContext,
  OpenClawPluginApi,
} from "./types.js";

export const id = "graphiti-openclaw-plugin";
export const name = "Graphiti Companion";
export const description =
  "Slot-less per-agent Graphiti auto-capture and auto-recall companion for OpenClaw";

function isBackgroundRun(ctx: HookContext): boolean {
  if (ctx.trigger === "cron" || ctx.trigger === "heartbeat") return true;
  const sessionKey = ctx.sessionKey ?? "";
  return sessionKey.includes(":cron:") || sessionKey.includes(":subagent:");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function register(api: OpenClawPluginApi): void {
  const cfg = parseConfig(api.pluginConfig);
  const client = new GraphitiMcpClient(cfg.baseUrl, cfg.requestTimeoutMs);

  const log = (message: string): void => {
    if (cfg.logOperations) api.logger.info(`graphiti: ${message}`);
  };

  const buffer = new AgentTurnBuffer(
    cfg.captureBatchTurns,
    cfg.captureBatchIdleFlushSeconds * 1_000,
    async (agentId, turns, reason) => {
      const body = formatTurnsForEpisode(turns);
      if (body.length > cfg.captureMaxChars) {
        api.logger.warn(
          `graphiti: capture batch exceeds captureMaxChars ` +
            `(agentId=${agentId}, chars=${body.length}, configured=${cfg.captureMaxChars}); ` +
            "submitting intact to avoid silent data loss",
        );
      }

      const started = Date.now();
      const result = await client.addMemory({
        name: `openclaw-${agentId}-${new Date().toISOString()}`,
        episodeBody: body,
        groupId: agentId,
        sourceDescription: `OpenClaw completed conversation turns for agent ${agentId}`,
      });
      if (typeof result.error === "string") throw new Error(result.error);

      log(
        `capture queue accepted agentId=${agentId} group_id=${agentId} ` +
          `turns=${turns.length} reason=${reason} durationMs=${Date.now() - started}`,
      );
    },
    {
      onBuffered: (agentId, turns) =>
        log(`capture buffered agentId=${agentId} group_id=${agentId} bufferTurns=${turns}`),
      onFlushError: (agentId, reason, error) =>
        api.logger.warn(
          `graphiti: capture flush failed agentId=${agentId} group_id=${agentId} ` +
            `reason=${reason} error=${errorText(error)}`,
        ),
    },
  );

  if (cfg.autoRecall) {
    api.on(
      "before_prompt_build",
      async (rawEvent: unknown, ctx?: HookContext): Promise<BeforePromptBuildResult | void> => {
        const event = rawEvent as BeforePromptBuildEvent;
        let agentId: string;
        try {
          agentId = requireAgentId(ctx?.agentId);
        } catch (error) {
          api.logger.warn(`graphiti: auto-recall skipped: ${errorText(error)}`);
          return;
        }

        const query = prepareRecallQuery(event.prompt ?? "", cfg.recallQueryMaxChars);
        if (!query || query.startsWith(SESSION_RESET_PROMPT_PREFIX)) return;

        const started = Date.now();
        try {
          const facts = await client.searchFacts(query, agentId, cfg.recallLimit);
          const factTexts = facts
            .map((fact) => (typeof fact.fact === "string" ? fact.fact : ""))
            .filter(Boolean);
          const block = buildRecallBlock(factTexts, cfg.recallMaxInjectedChars);
          log(
            `recall agentId=${agentId} group_id=${agentId} results=${factTexts.length} ` +
              `injectedChars=${block?.length ?? 0} durationMs=${Date.now() - started}`,
          );
          return block ? { prependContext: block } : undefined;
        } catch (error) {
          api.logger.warn(
            `graphiti: auto-recall failed agentId=${agentId} group_id=${agentId} ` +
              `error=${errorText(error)}`,
          );
          return;
        }
      },
      { timeoutMs: cfg.requestTimeoutMs },
    );
  }

  if (cfg.autoCapture) {
    api.on("agent_end", (rawEvent: unknown, ctx?: HookContext): void => {
      const event = rawEvent as AgentEndEvent;
      if (!event.success || isBackgroundRun(ctx ?? {})) return;
      if (ctx?.sessionKey === SLUG_GENERATOR_SESSION_KEY) return;

      let agentId: string;
      try {
        agentId = requireAgentId(ctx?.agentId);
      } catch (error) {
        api.logger.warn(`graphiti: auto-capture skipped: ${errorText(error)}`);
        return;
      }

      const turn = extractCompletedTurn(Array.isArray(event.messages) ? event.messages : []);
      if (!turn) return;
      buffer.add(agentId, turn);
    });
  }

  api.logger.info(
    `graphiti: plugin loaded autoCapture=${cfg.autoCapture} autoRecall=${cfg.autoRecall} ` +
      `captureBatchTurns=${cfg.captureBatchTurns} ` +
      `captureBatchIdleFlushSeconds=${cfg.captureBatchIdleFlushSeconds}`,
  );
}

export default { id, name, description, register };
