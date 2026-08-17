type JsonObject = Record<string, unknown>;

export const CUSTOM_EXTRACTION_PROMPT = `This JSON is a conversation between the two participants whose canonical names are in "participants.user" and "participants.assistant". "messages" is an ARRAY of message objects, each with a "text" field. Extract ALL entities from the "text" field of each message in the "messages" array. The participants often refer to each other and to people by name; a name may appear in slightly different forms (case, nicknames). When a mentioned name clearly refers to one of the participants, treat it as the same entity. Do not merge different people into one unless it is clearly the same person. Respect all other extraction rules.`;

export const OPENCLAW_SOURCE_DESCRIPTION = "OpenClaw conversation batch";

type JsonRpcResponse = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
};

export type SagaState = {
  uuid: string;
  name: string;
  groupId: string;
  createdAt?: string;
  summary: string;
  firstEpisodeUuid?: string;
  lastEpisodeUuid?: string;
  episodeCount: number;
};

export type QueueStatus = {
  groupId: string;
  blocked: boolean;
  attempts: number;
  pending: number;
  lastError?: string;
  episodeUuid?: string;
  episodeName?: string;
  saga?: string;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (isObject(value) && typeof value.message === "string") return value.message;
  return String(value);
}

function parseSseBody(body: string, requestId: number): JsonRpcResponse {
  const payloads: JsonRpcResponse[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) continue;
    try {
      payloads.push(JSON.parse(data) as JsonRpcResponse);
    } catch {
      // Only JSON-RPC SSE payloads matter here.
    }
  }

  const matching = payloads.find((payload) => payload.id === requestId);
  if (matching) return matching;
  if (payloads.length > 0) return payloads[payloads.length - 1];
  throw new Error("MCP SSE response contained no JSON-RPC payload");
}

/** Normalize FastMCP structuredContent, including the {result:{...}} wrapper used by Graphiti. */
function normalizeStructuredResult(value: JsonObject): JsonObject {
  return isObject(value.result) ? value.result : value;
}

function decodeToolResult(result: unknown): JsonObject {
  if (!isObject(result)) throw new Error("MCP tool call returned an invalid result");
  if (result.isError === true) {
    const text = Array.isArray(result.content)
      ? result.content
          .map((item) => (isObject(item) && typeof item.text === "string" ? item.text : ""))
          .filter(Boolean)
          .join("\n")
      : "";
    throw new Error(text || "Graphiti MCP tool returned isError=true");
  }

  if (isObject(result.structuredContent)) {
    return normalizeStructuredResult(result.structuredContent);
  }

  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isObject(item) || typeof item.text !== "string") continue;
      try {
        const parsed = JSON.parse(item.text) as unknown;
        if (isObject(parsed)) return normalizeStructuredResult(parsed);
      } catch {
        // Plain text is not useful for the structured Graphiti tools used here.
      }
    }
  }

  return {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Graphiti returned invalid ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function requiredNonnegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Graphiti returned invalid ${field}`);
  }
  return value;
}

export class GraphitiMcpClient {
  private sessionId?: string;
  private protocolVersion = "2025-06-18";
  private initialized = false;
  private initializing?: Promise<void>;
  private nextId = 1;
  private readonly rawLogger?: (kind: "request" | "response", body: string) => void;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    rawLogger?: (kind: "request" | "response", body: string) => void,
  ) {
    this.rawLogger = rawLogger;
  }

  async addMemory(params: {
    uuid: string;
    name: string;
    jsonBody: string;
    groupId: string;
    /** Omitted for standalone episodes such as agent notes, which belong to no dialog chronology. */
    saga?: string;
    referenceTime: string;
    previousEpisodeUuids: string[];
    sagaPreviousEpisodeUuid?: string;
    sourceDescription?: string;
  }): Promise<JsonObject> {
    const args: JsonObject = {
      uuid: params.uuid,
      name: params.name,
      episode_body: params.jsonBody,
      group_id: params.groupId,
      source: "json",
      source_description: params.sourceDescription ?? OPENCLAW_SOURCE_DESCRIPTION,
      reference_time: params.referenceTime,
      previous_episode_uuids: params.previousEpisodeUuids,
      custom_extraction_instructions: CUSTOM_EXTRACTION_PROMPT,
    };
    if (params.saga) args.saga = params.saga;
    if (params.sagaPreviousEpisodeUuid) {
      args.saga_previous_episode_uuid = params.sagaPreviousEpisodeUuid;
    }
    return this.callTool("add_memory", args);
  }

  async getSaga(sagaName: string, groupId: string): Promise<SagaState | undefined> {
    const result = await this.callTool("get_saga", {
      saga_name: sagaName,
      group_id: groupId,
    });
    if (typeof result.error === "string") {
      if (/^No saga named /.test(result.error)) return undefined;
      throw new Error(result.error);
    }
    const episodeCount = requiredNonnegativeInteger(result.episode_count, "episode_count");
    return {
      uuid: requiredString(result.uuid, "uuid"),
      name: requiredString(result.name, "name"),
      groupId: requiredString(result.group_id, "group_id"),
      createdAt: optionalString(result.created_at),
      summary: typeof result.summary === "string" ? result.summary : "",
      firstEpisodeUuid: optionalString(result.first_episode_uuid),
      lastEpisodeUuid: optionalString(result.last_episode_uuid),
      episodeCount,
    };
  }

  async getQueueStatus(groupId: string): Promise<QueueStatus> {
    const result = await this.callTool("get_queue_status", { group_id: groupId });
    if (typeof result.error === "string") throw new Error(result.error);
    if (typeof result.blocked !== "boolean") {
      throw new Error("Graphiti get_queue_status returned invalid blocked");
    }
    return {
      groupId: requiredString(result.group_id, "group_id"),
      blocked: result.blocked,
      attempts: requiredNonnegativeInteger(result.attempts, "attempts"),
      pending: requiredNonnegativeInteger(result.pending, "pending"),
      lastError: optionalString(result.last_error),
      episodeUuid: optionalString(result.episode_uuid),
      episodeName: optionalString(result.episode_name),
      saga: optionalString(result.saga),
    };
  }

  /**
   * Entity search. Like searchFacts this is scoped to one group, which the fork
   * resolves to that agent's physical graph.
   */
  async getEpisodes(groupId: string, limit: number): Promise<JsonObject[]> {
    const result = await this.callTool("get_episodes", {
      group_ids: groupId,
      max_episodes: limit,
    });
    if (typeof result.error === "string") throw new Error(result.error);
    return Array.isArray(result.episodes)
      ? result.episodes.filter((episode): episode is JsonObject => isObject(episode))
      : [];
  }

  /**
   * Graph size, shape and integrity, from the fork's read-only diagnostics tool.
   *
   * The report is returned as received: it is a bag of independently gathered
   * sections, and one unavailable section must not cost us the others, so shape
   * validation belongs where the report is rendered rather than here.
   */
  async getGraphStats(
    groupId: string,
    topEntities: number,
    standaloneSourceDescription?: string,
  ): Promise<JsonObject> {
    const result = await this.callTool("get_graph_stats", {
      group_id: groupId,
      top_entities: topEntities,
      standalone_source_description: standaloneSourceDescription ?? null,
    });
    if (typeof result.error === "string") throw new Error(result.error);
    return result;
  }

  /** Fetch specific episodes, with their text, by uuid or by name. */
  async getEpisodesByRef(
    groupId: string,
    refs: { uuids?: string[]; names?: string[] },
  ): Promise<JsonObject[]> {
    const result = await this.callTool("get_episodes_by_ref", {
      group_id: groupId,
      uuids: refs.uuids ?? [],
      names: refs.names ?? [],
    });
    if (typeof result.error === "string") throw new Error(result.error);
    return Array.isArray(result.episodes)
      ? result.episodes.filter((episode): episode is JsonObject => isObject(episode))
      : [];
  }

  /**
   * One search returning facts, entities and episodes, each with its score.
   *
   * Replaces the separate fact and node searches: the server runs a single
   * retrieval pass, and the scores it computes survive the trip, which is what
   * lets an agent choose what to expand by number rather than by position.
   */
  async searchCombined(
    query: string,
    groupId: string,
    limit: number,
    filters: {
      validAtAfter?: string;
      validAtBefore?: string;
      createdAtAfter?: string;
    } = {},
  ): Promise<{ facts: JsonObject[]; entities: JsonObject[]; episodes: JsonObject[] }> {
    const result = await this.callTool("search_memory_combined", {
      query,
      group_id: groupId,
      limit,
      valid_at_after: filters.validAtAfter ?? null,
      valid_at_before: filters.validAtBefore ?? null,
      created_at_after: filters.createdAtAfter ?? null,
    });
    if (typeof result.error === "string") throw new Error(result.error);
    const list = (value: unknown): JsonObject[] =>
      Array.isArray(value) ? value.filter((item): item is JsonObject => isObject(item)) : [];
    return {
      facts: list(result.facts),
      entities: list(result.entities),
      episodes: list(result.episodes),
    };
  }

  async searchFacts(query: string, groupId: string, limit: number): Promise<JsonObject[]> {
    const result = await this.callTool("search_memory_facts", {
      query,
      group_ids: groupId,
      max_facts: limit,
    });
    if (typeof result.error === "string") throw new Error(result.error);
    return Array.isArray(result.facts)
      ? result.facts.filter((fact): fact is JsonObject => isObject(fact))
      : [];
  }

  private async callTool(name: string, args: JsonObject): Promise<JsonObject> {
    await this.ensureInitialized();

    let response: JsonRpcResponse;
    try {
      response = await this.rpc("tools/call", { name, arguments: args });
    } catch (error) {
      // Only a transport-level session loss may be retried. A tool that ran and
      // answered with an error must never be re-sent: for add_memory that would
      // submit the same episode twice.
      if (!this.initialized) throw error;
      if (!/404|session/i.test(errorMessage(error))) throw error;

      this.resetSession();
      await this.ensureInitialized();
      response = await this.rpc("tools/call", { name, arguments: args });
    }
    return decodeToolResult(response.result);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    // Concurrent callers (capture flush plus the backend health poll) must share
    // one handshake instead of racing two sessions onto the same client.
    this.initializing ??= this.initialize().finally(() => {
      this.initializing = undefined;
    });
    await this.initializing;
  }

  private async initialize(): Promise<void> {
    const response = await this.rpc(
      "initialize",
      {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: {
          name: "graphiti-openclaw-plugin",
          version: "0.1.0",
        },
      },
      false,
    );

    if (isObject(response.result) && typeof response.result.protocolVersion === "string") {
      this.protocolVersion = response.result.protocolVersion;
    }

    await this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  private resetSession(): void {
    this.sessionId = undefined;
    this.initialized = false;
  }

  private async rpc(
    method: string,
    params: JsonObject,
    includeProtocolHeader = true,
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const response = await this.post(payload, includeProtocolHeader);
    if (isObject(response.error)) {
      throw new Error(
        typeof response.error.message === "string"
          ? response.error.message
          : `MCP ${method} failed`,
      );
    }
    return response;
  }

  private async notify(method: string, params: JsonObject): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params }, true, true);
  }

  private async post(
    payload: JsonObject,
    includeProtocolHeader: boolean,
    notification = false,
  ): Promise<JsonRpcResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = new Headers({
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      });
      if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
      if (includeProtocolHeader) headers.set("MCP-Protocol-Version", this.protocolVersion);

      this.rawLogger?.(
        "request",
        `POST ${this.baseUrl}\n${[...headers.entries()]
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")}\n\n${JSON.stringify(payload)}`,
      );

      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const sessionId = response.headers.get("Mcp-Session-Id");
      if (sessionId) this.sessionId = sessionId;

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        this.rawLogger?.("response", `HTTP ${response.status}\n${detail}`);
        throw new Error(`Graphiti MCP HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }

      if (notification || response.status === 202 || response.status === 204) return {};

      const body = await response.text();
      this.rawLogger?.(
        "response",
        `HTTP ${response.status} ${response.headers.get("content-type") ?? ""}\n${body}`,
      );
      if (!body.trim()) throw new Error("Graphiti MCP returned an empty response");
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        const id = typeof payload.id === "number" ? payload.id : -1;
        return parseSseBody(body, id);
      }
      return JSON.parse(body) as JsonRpcResponse;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Graphiti MCP request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
