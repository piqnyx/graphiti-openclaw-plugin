type JsonObject = Record<string, unknown>;

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
      const parsed = JSON.parse(data) as JsonRpcResponse;
      payloads.push(parsed);
    } catch {
      // Ignore non-JSON SSE events; MCP JSON-RPC payloads are the only relevant events here.
    }
  }

  const matching = payloads.find((payload) => payload.id === requestId);
  if (matching) return matching;
  if (payloads.length > 0) return payloads[payloads.length - 1];
  throw new Error("MCP SSE response contained no JSON-RPC payload");
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

  if (isObject(result.structuredContent)) return result.structuredContent;

  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isObject(item) || typeof item.text !== "string") continue;
      try {
        const parsed = JSON.parse(item.text) as unknown;
        if (isObject(parsed)) return parsed;
      } catch {
        // A plain text tool result is not useful for the structured Graphiti calls used here.
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

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async addMemory(params: {
    name: string;
    jsonBody: string;
    groupId: string;
    saga: string;
    referenceTime: string;
    customExtractionInstructions?: string;
  }): Promise<JsonObject> {
    return this.callTool("add_memory", {
      name: params.name,
      episode_body: params.jsonBody,
      group_id: params.groupId,
      source: "json",
      saga: params.saga,
      reference_time: params.referenceTime,
      ...(params.customExtractionInstructions
        ? { custom_extraction_instructions: params.customExtractionInstructions }
        : {}),
    });
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
        throw new Error(`Graphiti MCP HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }

      if (notification || response.status === 202 || response.status === 204) return {};

      const body = await response.text();
      if (!body.trim()) throw new Error("Graphiti MCP returned an empty response");
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        const id = isObject(payload) && typeof payload.id === "number" ? payload.id : -1;
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
