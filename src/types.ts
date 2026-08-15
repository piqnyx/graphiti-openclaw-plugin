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

export type PluginJsonValue =
  | null
  | boolean
  | number
  | string
  | PluginJsonValue[]
  | { [key: string]: PluginJsonValue };

export type SessionEntryLike = {
  pluginExtensions?: Record<string, Record<string, PluginJsonValue>>;
};

export type OpenClawPluginApi = {
  pluginConfig?: unknown;
  logger: PluginLogger;
  on: (
    hookName: string,
    handler: (event: unknown, ctx?: HookContext) => unknown,
    opts?: { priority?: number; timeoutMs?: number },
  ) => void;
  session?: {
    state?: {
      registerSessionExtension: (extension: {
        namespace: string;
        description: string;
        project?: (ctx: {
          sessionKey: string;
          sessionId?: string;
          state: PluginJsonValue | undefined;
        }) => PluginJsonValue | undefined;
      }) => void;
    };
    controls?: {
      registerControlUiDescriptor: (descriptor: {
        id: string;
        surface: "session" | "tool" | "run" | "settings" | "tab" | "widget";
        label: string;
        description?: string;
        placement?: string;
        schema?: PluginJsonValue;
      }) => void;
    };
  };
  runtime?: {
    agent?: {
      session?: {
        patchSessionEntry: (params: {
          agentId?: string;
          sessionKey: string;
          preserveActivity?: boolean;
          update: (entry: SessionEntryLike) => Partial<SessionEntryLike> | null;
        }) => Promise<unknown>;
      };
    };
  };
};
