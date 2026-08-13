export function requireAgentId(value: unknown): string {
  if (typeof value !== "string") throw new Error("missing OpenClaw ctx.agentId");
  const agentId = value.trim();
  if (!agentId) throw new Error("empty OpenClaw ctx.agentId");
  if (agentId !== value) throw new Error("OpenClaw ctx.agentId contains surrounding whitespace");
  if (agentId.length > 128) throw new Error("OpenClaw ctx.agentId is too long");
  if (/\p{Cc}/u.test(agentId)) throw new Error("OpenClaw ctx.agentId contains control characters");
  return agentId;
}
