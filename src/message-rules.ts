/**
 * Rules that decide what a message looks like by the time the graph sees it.
 *
 * A tool that answers with a table is read once and is stale within the hour,
 * but the graph stores what it is given as a fact without a shelf life. One
 * report of key health -- thirty keys, so many percent -- becomes a handful of
 * timeless assertions that will be wrong by morning and that nothing retracts.
 * Asking the same question daily does not correct them; it entrenches them.
 *
 * Two modes, because the two useful answers are different:
 *
 * `ignore` drops the message. Nothing of it reaches the graph.
 *
 * `replace` keeps the turn and substitutes its text. The chronology stays
 * intact and it is still visible that an answer was given, but there is
 * nothing left to extract. This is usually the one you want: a dropped
 * assistant turn leaves a question in the graph that was never answered.
 *
 * Matching is by search, not by whole-string match: a report arrives wrapped in
 * a sentence or two of the assistant's own words, and the rule has to find it
 * there. First match wins -- with whole-message replacement, applying a second
 * rule to the result would only overwrite the first one's work.
 */

export type MessageRuleMode = "ignore" | "replace";

export type MessageRule = {
  name: string;
  pattern: string;
  mode: MessageRuleMode;
  replacement: string;
  flags: string;
};

export type CompiledMessageRule = {
  name: string;
  mode: MessageRuleMode;
  replacement: string;
  regex: RegExp;
};

/** What a rule decided about one message. */
export type MessageRuleOutcome =
  | { kept: true; text: string; rule?: undefined }
  | { kept: true; text: string; rule: CompiledMessageRule; original: string }
  | { kept: false; rule: CompiledMessageRule; original: string };

export const MAX_MESSAGE_RULES = 32;
export const MAX_MESSAGE_RULE_PATTERN_LENGTH = 512;
export const MAX_MESSAGE_RULE_REPLACEMENT_LENGTH = 512;
const ALLOWED_FLAGS = /^[imsu]*$/;

export function compileMessageRules(rules: readonly MessageRule[]): CompiledMessageRule[] {
  return rules.map((rule) => ({
    name: rule.name,
    mode: rule.mode,
    replacement: rule.replacement,
    regex: new RegExp(rule.pattern, rule.flags),
  }));
}

/**
 * The first rule that matches decides. A message no rule matches comes back
 * unchanged, which is the overwhelmingly common case and costs one test per
 * rule -- rules are few and the list is capped.
 */
export function applyMessageRules(
  text: string,
  rules: readonly CompiledMessageRule[],
): MessageRuleOutcome {
  for (const rule of rules) {
    // A regex carrying /g keeps lastIndex between calls and would answer
    // differently on the same input. Reset before asking.
    rule.regex.lastIndex = 0;
    if (!rule.regex.test(text)) continue;
    if (rule.mode === "ignore") return { kept: false, rule, original: text };
    return { kept: true, text: rule.replacement, rule, original: text };
  }
  return { kept: true, text };
}

/** Validation shared by the config parser, kept next to what it validates. */
export function parseMessageRule(raw: unknown, index: number): MessageRule {
  const where = `messageRules[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} must be an object`);
  }
  const value = raw as Record<string, unknown>;

  const known = new Set(["name", "pattern", "mode", "replacement", "flags"]);
  const unknownKeys = Object.keys(value).filter((key) => !known.has(key));
  if (unknownKeys.length > 0) {
    // A misspelled key would otherwise leave the rule silently doing something
    // other than what was written, and this mechanism deletes data.
    throw new Error(`${where} has unknown keys: ${unknownKeys.join(", ")}`);
  }

  const name = value.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`${where}.name must be a non-empty string; it is what the log reports`);
  }

  const pattern = value.pattern;
  if (typeof pattern !== "string" || pattern.trim() === "") {
    throw new Error(`${where}.pattern must be a non-empty string`);
  }
  if (pattern.length > MAX_MESSAGE_RULE_PATTERN_LENGTH) {
    throw new Error(`${where}.pattern must be at most ${MAX_MESSAGE_RULE_PATTERN_LENGTH} characters`);
  }

  const flags = value.flags === undefined ? "" : value.flags;
  if (typeof flags !== "string" || !ALLOWED_FLAGS.test(flags)) {
    throw new Error(`${where}.flags may only contain i, m, s or u`);
  }

  try {
    new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(
      `${where}.pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const mode = value.mode;
  if (mode !== "ignore" && mode !== "replace") {
    throw new Error(`${where}.mode must be "ignore" or "replace"`);
  }

  const replacement = value.replacement === undefined ? "" : value.replacement;
  if (typeof replacement !== "string") {
    throw new Error(`${where}.replacement must be a string`);
  }
  if (replacement.length > MAX_MESSAGE_RULE_REPLACEMENT_LENGTH) {
    throw new Error(
      `${where}.replacement must be at most ${MAX_MESSAGE_RULE_REPLACEMENT_LENGTH} characters`,
    );
  }
  if (mode === "replace" && replacement.trim() === "") {
    // An empty replacement under "replace" is indistinguishable from "ignore"
    // once it reaches the buffer, where empty text is dropped anyway. Saying so
    // is better than silently doing the other thing.
    throw new Error(`${where}.replacement must not be empty when mode is "replace"; use "ignore" instead`);
  }

  return { name: name.trim(), pattern, mode, replacement, flags };
}
