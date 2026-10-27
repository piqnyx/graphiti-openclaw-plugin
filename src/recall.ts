import type { GraphitiPluginConfig } from "./config.js";
import type { GraphitiLogger } from "./logging.js";
import type { GraphitiMcpClient } from "./mcp-client.js";
import type { CompiledMessageRule } from "./message-rules.js";
import { factSources, type FactSource } from "./recall-expand.js";
import {
  buildRecallBlockDetailed,
  buildRecallQuery,
  factsInForce,
  type ConversationMessage,
  type RecallBlockResult,
} from "./text.js";

/**
 * Recall for one prompt: what the before_prompt_build hook does on a turn, and what
 * the recall command does for a caller outside the gateway. The news digest reads
 * each post against memory the way Eva's own turn would -- the same query, the same
 * floors, the same block (digest PLAN.md, stage 2). One code path for both, so the
 * two cannot drift apart.
 */

/** The search query for a prompt and the conversation around it; "" when nothing is left to search for. */
export function recallQuery(
  cfg: GraphitiPluginConfig,
  agentId: string,
  currentPrompt: string,
  history: readonly ConversationMessage[],
  messageRules: readonly CompiledMessageRule[],
): string {
  return buildRecallQuery(currentPrompt, history, {
    useHistory: cfg.recallUseHistory,
    historyMaxMessages: cfg.recallHistoryMaxMessages,
    historyMaxChars: cfg.recallHistoryMaxChars,
    maxChars: cfg.recallQueryMaxChars,
    userName: cfg.agents[agentId]?.user,
    assistantName: cfg.agents[agentId]?.assistant,
    messageRules,
  });
}

export type RecallFound = {
  facts: Record<string, unknown>[];
  rankedBy: string;
  inForce: Record<string, unknown>[];
  factTexts: string[];
  sources: (FactSource | undefined)[];
  recallBlock: RecallBlockResult;
};

/** The facts for a query, where each came from, and the block that goes before the prompt. */
export async function recallFacts(params: {
  client: GraphitiMcpClient;
  cfg: GraphitiPluginConfig;
  logger: GraphitiLogger;
  agentId: string;
  query: string;
  /** What the reranker scores against: the message just sent, not the transcript around it. */
  focus: string;
}): Promise<RecallFound> {
  const { client, cfg, logger, agentId, query, focus } = params;
  const found = await client.searchFacts(query, agentId, cfg.recallLimit, {
    pool: cfg.recallPool,
    rerank: cfg.recallRerank,
    minScore: cfg.recallMinScore,
    contextMinScore: cfg.recallContextMinScore,
    minSpread: cfg.recallMinSpread,
    vectorMinScore: cfg.recallVectorMinScore,
    // What the reranker scores against: the message just sent, not the
    // transcript around it. The transcript is what found the candidates.
    focus,
  });
  const facts = found.facts;
  const inForce = factsInForce(facts);
  const factTexts = inForce.map((fact) => fact.fact as string);

  // Where each fact came from, and what was said around the first few. Both
  // are extras: a store that cannot be read, or an episode that is gone,
  // costs the attribution and never the recall.
  let sources: (FactSource | undefined)[] = [];
  if (inForce.length > 0) {
    try {
      sources = await factSources(
        client,
        agentId,
        inForce,
        cfg.recallExpandTop,
        cfg.recallExpandChars,
      );
    } catch (error) {
      logger.warn("recall_expand_failed", {
        agentId,
        group_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const entries = factTexts.map((fact, index) =>
    sources[index] ? { fact, source: sources[index] } : fact,
  );
  const recallBlock = buildRecallBlockDetailed(entries, cfg.recallMaxInjectedChars, cfg.recallExpandChars);
  return { facts, rankedBy: found.rankedBy, inForce, factTexts, sources, recallBlock };
}
