type JsonObject = Record<string, unknown>;

export const CUSTOM_EXTRACTION_PROMPT = `This JSON is a conversation between the two participants whose canonical names are in "participants.user" and "participants.assistant". "messages" is an ARRAY of message objects, each with a "text" field. Extract ALL entities from the "text" field of each message in the "messages" array. The participants often refer to each other and to people by name; a name may appear in slightly different forms (case, nicknames). When a mentioned name clearly refers to one of the participants, treat it as the same entity. Do not merge different people into one unless it is clearly the same person. Respect all other extraction rules.`;

export const OPENCLAW_SOURCE_DESCRIPTION = "OpenClaw conversation batch";

type JsonRpcResponse = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
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

export class GraphitiMcpClient {
  private sessionId?: string;
  private protocolVersion = "2025-06-18";
  private initialized = false;
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
    saga: string;
    referenceTime: string;
    previousEpisodeUuids: string[];
    sagaPreviousEpisodeUuid?: string;
  }): Promise<JsonObject> {
    const args: JsonObject = {
      uuid: params.uuid,
      name: params.name,
      episode_body: params.jsonBody,
      group_id: params.groupId,
      source: "json",
      source_description: OPENCLAW_SOURCE_DESCRIPTION,
      saga: params.saga,
      reference_time: params.referenceTime,
      previous_episode_uuids: params.previousEpisodeUuids,
      custom_extraction_instructions: CUSTOM_EXTRACTION_PROMPT,
    };
    if (params.sagaPreviousEpisodeUuid) {
      args.saga_previous_episode_uuid = params.sagaPreviousEpisodeUuid;
    }
    return this.callTool("add_memory", args);
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
    try {
      const response = await this.rpc("tools/call", { name, arguments: args });
      return decodeToolResult(response.result);
    } catch (error) {
      if (!this.initialized) throw error;
      if (!/404|session/i.test(errorMessage(error))) throw error;

      this.resetSession();
      await this.ensureInitialized();
      const response = await this.rpc("tools/call", { name, arguments: args });
      return decodeToolResult(response.result);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

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
