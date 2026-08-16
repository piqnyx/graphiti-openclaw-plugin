/**
 * Session exclusion, shared by capture and recall.
 *
 * There is exactly one source of truth for "this session must not touch
 * Graphiti": the `excludeSessionPatterns` config list. Each entry is a
 * JavaScript regular expression source, unanchored, tested against:
 *
 *   1. the OpenClaw session key (`agent:main:telegram:42`);
 *   2. the run trigger (`cron`, `heartbeat`, `user`, ...), so a background run
 *      is still excluded when its session key carries no marker.
 *
 * Anchor a pattern when you mean it: `:cron:` matches anywhere inside the key,
 * `^cron$` matches the trigger exactly.
 */
export type SessionExclusion = {
  pattern: string;
  matched: "sessionKey" | "trigger";
};

export function compileSessionPattern(pattern: string): RegExp {
  return new RegExp(pattern);
}

export function compileSessionPatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map(compileSessionPattern);
}

export function matchSessionExclusion(
  ctx: { sessionKey?: string; trigger?: string },
  patterns: readonly RegExp[],
): SessionExclusion | undefined {
  if (patterns.length === 0) return undefined;

  const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey.trim() : "";
  const trigger = typeof ctx.trigger === "string" ? ctx.trigger.trim() : "";

  for (const pattern of patterns) {
    // Patterns are compiled without the global flag, so lastIndex never carries
    // over between calls and every test starts from the beginning.
    if (sessionKey && pattern.test(sessionKey)) {
      return { pattern: pattern.source, matched: "sessionKey" };
    }
    if (trigger && pattern.test(trigger)) {
      return { pattern: pattern.source, matched: "trigger" };
    }
  }
  return undefined;
}
