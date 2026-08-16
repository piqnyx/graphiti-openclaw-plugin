/**
 * Session key exclusion, shared by capture and recall.
 *
 * Patterns use the same glob dialect as the OpenViking plugin's
 * bypassSessionPatterns, so one mental model covers both memory layers:
 *
 *   *  matches within a single ":" segment
 *   ** matches across segments
 *
 * Example: `agent:*:dreaming-**` excludes every dreaming session of every agent.
 */
export function compileSessionPattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    // NUL is a placeholder for "**" because it can never occur in a session key.
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^:]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function compileSessionPatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map(compileSessionPattern);
}

/** An unknown session key can never match; the caller decides what that means. */
export function matchesSessionPattern(
  sessionKey: string | undefined,
  patterns: readonly RegExp[],
): string | undefined {
  if (patterns.length === 0) return undefined;
  const candidate = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (!candidate) return undefined;
  return patterns.find((pattern) => pattern.test(candidate))?.source;
}
