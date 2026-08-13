export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type HookContext = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  trigger?: string;
};

export type AgentEndEvent = {
  runId?: string;
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
};

export type BeforePromptBuildEvent = {
  prompt: string;
  messages: unknown[];
};

export type BeforePromptBuildResult = {
  prependContext?: string;
};

export type OpenClawPluginApi = {
  pluginConfig?: unknown;
  logger: PluginLogger;
  on: (
    hookName: string,
    handler: (event: unknown, ctx?: HookContext) => unknown,
    opts?: { priority?: number; timeoutMs?: number },
  ) => void;
};

export type CompletedTurn = {
  user: string;
  assistant: string;
};

export type FlushReason = "threshold" | "idle";
