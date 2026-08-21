type JsonObject = Record<string, unknown>;

/** Ceiling on the text handed to the cross-encoder as the thing to rank against. */
export const FOCUS_MAX_CHARS = 2_000;

export const CUSTOM_EXTRACTION_PROMPT = `This JSON is a conversation between the two participants whose canonical names are in "participants.user" and "participants.assistant". "messages" is an ARRAY of message objects, each with a "text" field. Extract ALL entities from the "text" field of each message in the "messages" array. The participants often refer to each other and to people by name; a name may appear in slightly different forms (case, nicknames). When a mentioned name clearly refers to one of the participants, treat it as the same entity. Do not merge different people into one unless it is clearly the same person. A message whose "text" begins with "[note]" is not something either participant said out loud: it is a statement written into memory on purpose, about the world. Extract from it exactly as from any other text, but attribute what it says to whoever it names rather than to the speaker of the message, and never record that someone asked for something to be remembered. Drop the "[note]" marker itself; it is not part of any fact. If it restates something already said in this same batch, that is one fact, not two. Respect all other extraction rules.`;

export const OPENCLAW_SOURCE_DESCRIPTION = "OpenClaw conversation batch";

const DEFAULT_DELIVERY_POLL_MS = 2_000;
const DEFAULT_DELIVERY_RESUBMIT_GRACE_MS = 120_000;

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
  chainCount?: number;
  integrityOk: boolean;
  integrityErrors: string[];
};

/**
 * Ownership of one UUID by the backend's episode queue.
 *
 * A queued UUID with no worker is stranded RAM rather than useful ownership. The
 * server normally self-heals that in get_queue_status, and after the ambiguity
 * grace, re-submitting the same UUID is the safe kick if it remains stranded.
 *
 * Both the replay preflight and the observation loop ask this question, so it is
 * written once: the two callers must never drift into disagreeing about who owns
 * an episode.
 */
function queueOwns(status: QueueStatus, uuid: string): boolean {
  const active = status.episodeUuid === uuid;
  const queued = status.queuedEpisodeUuids.includes(uuid);
  return active || (queued && status.workerRunning !== false);
}

export type QueueStatus = {
  groupId: string;
  blocked: boolean;
  attempts: number;
  pending: number;
  workerRunning?: boolean;
  lastError?: string;
  failureKind?: string;
  retryInSeconds?: number;
  episodeUuid?: string;
  episodeName?: string;
  saga?: string;
  queuedEpisodeUuids: string[];
};

class McpToolResultError extends Error {}
class McpJsonRpcError extends Error {}
class McpClientClosedError extends Error {
  constructor() {
    super("Graphiti MCP client is shutting down");
    this.name = "McpClientClosedError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (isObject(value) && typeof value.message === "string") return value.message;
  return String(value);
}

function isDefinitiveMcpError(value: unknown): boolean {
  return value instanceof McpToolResultError || value instanceof McpJsonRpcError;
}

function isClientClosedError(value: unknown): boolean {
  return value instanceof McpClientClosedError;
}

function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new McpClientClosedError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new McpClientClosedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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

function normalizeStructuredResult(value: JsonObject): JsonObject {
  return isObject(value.result) ? value.result : value;
}

function decodeToolResult(result: unknown): JsonObject {
  if (!isObject(result)) throw new McpToolResultError("MCP tool call returned an invalid result");
  if (result.isError === true) {
    const text = Array.isArray(result.content)
      ? result.content
          .map((item) => (isObject(item) && typeof item.text === "string" ? item.text : ""))
          .filter(Boolean)
          .join("\n")
      : "";
    throw new McpToolResultError(text || "Graphiti MCP tool returned isError=true");
  }

  if (isObject(result.structuredContent)) return normalizeStructuredResult(result.structuredContent);
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isObject(item) || typeof item.text !== "string") continue;
      try {
        const parsed = JSON.parse(item.text) as unknown;
        if (isObject(parsed)) return normalizeStructuredResult(parsed);
      } catch {
        // Plain text is irrelevant for the structured tools used here.
      }
    }
  }
  return {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpToolResultError(`Graphiti returned invalid ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function requiredNonnegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new McpToolResultError(`Graphiti returned invalid ${field}`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new McpToolResultError(`Graphiti returned invalid ${field}`);
  return value;
}

function optionalStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

export class GraphitiMcpClient {
  private sessionId?: string;
  private protocolVersion = "2025-06-18";
  private initialized = false;
  private initializing?: Promise<void>;
  private nextId = 1;
  private readonly rawLogger?: (kind: "request" | "response", body: string) => void;
  private readonly deliveryPollMs: number;
  private readonly deliveryResubmitGraceMs: number;
  private readonly lifecycle = new AbortController();

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    rawLogger?: (kind: "request" | "response", body: string) => void,
    deliveryOptions: { pollMs?: number; resubmitGraceMs?: number } = {},
  ) {
    this.rawLogger = rawLogger;
    this.deliveryPollMs = deliveryOptions.pollMs ?? DEFAULT_DELIVERY_POLL_MS;
    this.deliveryResubmitGraceMs =
      deliveryOptions.resubmitGraceMs ?? DEFAULT_DELIVERY_RESUBMIT_GRACE_MS;
    if (!Number.isFinite(this.deliveryPollMs) || this.deliveryPollMs < 0) {
      throw new Error("delivery pollMs must be a non-negative finite number");
    }
    if (!Number.isFinite(this.deliveryResubmitGraceMs) || this.deliveryResubmitGraceMs < 0) {
      throw new Error("delivery resubmitGraceMs must be a non-negative finite number");
    }
  }

  close(): void {
    if (!this.lifecycle.signal.aborted) this.lifecycle.abort();
    this.resetSession();
  }

  /** Whether the backend is running this episode, or holds it behind a live worker. */
  private async backendOwnsEpisode(groupId: string, uuid: string): Promise<boolean> {
    return queueOwns(await this.getQueueStatus(groupId), uuid);
  }

  private assertOpen(): void {
    if (this.lifecycle.signal.aborted) throw new McpClientClosedError();
  }

  /**
   * Deliver one durable FIFO head and return only after a structurally valid Saga
   * reports that exact UUID as its committed tail.
   *
   * First handoff is immediate. MCP is local and is not a reason to preflight the
   * graph or sleep before enqueueing ordinary work. Only an ambiguous post-send
   * transport outcome enters the observation/grace path before the same UUID may
   * be submitted again. The durable caller keeps the head on disk the whole time.
   *
   * `replayed` is the exception, and it exists because the graph answers a
   * narrower question than the one being asked. A restart mid-delivery leaves a
   * head whose episode the backend may still be extracting -- minutes of work --
   * and during that time the Saga tail is still the predecessor, so "is it
   * committed?" answers no while the truthful answer is "not yet, it is running".
   * Submitting then hands the backend a second task for the same UUID: its
   * episode queue holds closures and does not dedupe, so the extraction runs
   * twice and both runs attach the episode to the Saga after the same
   * predecessor, which is how a chain grows a second head. A replayed head
   * therefore asks the queue first and submits only if nobody owns the UUID.
   */
  async addMemory(params: {
    uuid: string;
    name: string;
    jsonBody: string;
    groupId: string;
    saga?: string;
    referenceTime: string;
    previousEpisodeUuids: string[];
    sagaPreviousEpisodeUuid?: string;
    sourceDescription?: string;
    /** This head outlived a restart: the backend may already be working on it. */
    replayed?: boolean;
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
    if (params.sagaPreviousEpisodeUuid) args.saga_previous_episode_uuid = params.sagaPreviousEpisodeUuid;

    // Initialization is a local prerequisite, not an ambiguous mutation. If MCP is
    // actually down, fail promptly and let the durable outer queue retry later.
    await this.ensureInitialized();

    let lastSubmissionResult: JsonObject = {};
    let lastSubmissionAt = Date.now();

    try {
      if (await this.episodeCommitted(params)) {
        return { uuid: params.uuid, persisted: true };
      }

      if (!(params.replayed && (await this.backendOwnsEpisode(params.groupId, params.uuid)))) {
        lastSubmissionResult = await this.callToolOnce("add_memory", args);
        if (typeof lastSubmissionResult.error === "string") {
          throw new McpToolResultError(lastSubmissionResult.error);
        }
      }
    } catch (error) {
      if (isClientClosedError(error) || isDefinitiveMcpError(error)) throw error;
      // The request may have reached add_memory before the transport failed. Never
      // turn that uncertainty into an immediate duplicate. Observe graph/queue state.
    }

    while (true) {
      this.assertOpen();
      try {
        if (await this.episodeCommitted(params)) {
          return { ...lastSubmissionResult, uuid: params.uuid, persisted: true };
        }
      } catch (error) {
        if (isClientClosedError(error) || isDefinitiveMcpError(error)) throw error;
        await cancellableSleep(this.deliveryPollMs, this.lifecycle.signal);
        continue;
      }

      let status: QueueStatus;
      try {
        status = await this.getQueueStatus(params.groupId);
      } catch (error) {
        if (isClientClosedError(error) || isDefinitiveMcpError(error)) throw error;
        await cancellableSleep(this.deliveryPollMs, this.lifecycle.signal);
        continue;
      }

      const backendOwnsUuid = queueOwns(status, params.uuid);
      const submissionOldEnough =
        Date.now() - lastSubmissionAt >= this.deliveryResubmitGraceMs;

      if (!backendOwnsUuid && submissionOldEnough) {
        try {
          if (await this.episodeCommitted(params)) {
            return lastSubmissionResult;
          }
          lastSubmissionResult = await this.callToolOnce("add_memory", args);
          if (typeof lastSubmissionResult.error === "string") {
            throw new McpToolResultError(lastSubmissionResult.error);
          }
        } catch (error) {
          if (isClientClosedError(error) || isDefinitiveMcpError(error)) throw error;
          // Same ambiguity rule on a later kick: wait and observe before another.
        }
        lastSubmissionAt = Date.now();
      }

      await cancellableSleep(this.deliveryPollMs, this.lifecycle.signal);
    }
  }

  private async episodeCommitted(params: {
    uuid: string;
    groupId: string;
    saga?: string;
    previousEpisodeUuids: string[];
  }): Promise<boolean> {
    const episodes = await this.getEpisodesByRef(params.groupId, { uuids: [params.uuid] });
    if (!episodes.some((episode) => episode.uuid === params.uuid)) return false;
    if (!params.saga) return true;

    const saga = await this.getSaga(params.saga, params.groupId);
    if (!saga) return false;
    if (!saga.integrityOk) {
      return false;
    }
    if (saga.lastEpisodeUuid !== params.uuid) return false;
    if (params.previousEpisodeUuids.length === 0 && saga.firstEpisodeUuid !== params.uuid) return false;
    return true;
  }

  async getSaga(sagaName: string, groupId: string): Promise<SagaState | undefined> {
    const result = await this.callTool("get_saga", { saga_name: sagaName, group_id: groupId });
    if (typeof result.error === "string") {
      if (/^No saga named /.test(result.error)) return undefined;
      throw new McpToolResultError(result.error);
    }
    return {
      uuid: requiredString(result.uuid, "uuid"),
      name: requiredString(result.name, "name"),
      groupId: requiredString(result.group_id, "group_id"),
      createdAt: optionalString(result.created_at),
      summary: typeof result.summary === "string" ? result.summary : "",
      firstEpisodeUuid: optionalString(result.first_episode_uuid),
      lastEpisodeUuid: optionalString(result.last_episode_uuid),
      episodeCount: requiredNonnegativeInteger(result.episode_count, "episode_count"),
      chainCount:
      typeof result.chain_count === "number"
      ? result.chain_count
      : undefined,
      integrityOk:
        typeof result.integrity_ok === "boolean"
          ? result.integrity_ok
          : true,
      integrityErrors: optionalStringArray(result.integrity_errors),
    };
  }

  async getQueueStatus(groupId: string): Promise<QueueStatus> {
    const result = await this.callTool("get_queue_status", { group_id: groupId });
    if (typeof result.error === "string") throw new McpToolResultError(result.error);

    const status: QueueStatus = {
      groupId: requiredString(result.group_id, "group_id"),
      blocked: requiredBoolean(result.blocked, "blocked"),
      attempts: requiredNonnegativeInteger(result.attempts, "attempts"),
      pending: requiredNonnegativeInteger(result.pending, "pending"),
      queuedEpisodeUuids: optionalStringArray(result.queued_episode_uuids),
    };
    const workerRunning = typeof result.worker_running === "boolean" ? result.worker_running : undefined;
    const lastError = optionalString(result.last_error);
    const failureKind = optionalString(result.failure_kind);
    const retryInSeconds = optionalNonnegativeNumber(result.retry_in_seconds);
    const episodeUuid = optionalString(result.episode_uuid);
    const episodeName = optionalString(result.episode_name);
    const saga = optionalString(result.saga);
    if (workerRunning !== undefined) status.workerRunning = workerRunning;
    if (lastError !== undefined) status.lastError = lastError;
    if (failureKind !== undefined) status.failureKind = failureKind;
    if (retryInSeconds !== undefined) status.retryInSeconds = retryInSeconds;
    if (episodeUuid !== undefined) status.episodeUuid = episodeUuid;
    if (episodeName !== undefined) status.episodeName = episodeName;
    if (saga !== undefined) status.saga = saga;
    return status;
  }

  async getEpisodes(groupId: string, limit: number): Promise<JsonObject[]> {
    const result = await this.callTool("get_episodes", { group_ids: groupId, max_episodes: limit });
    if (typeof result.error === "string") throw new Error(result.error);
    return Array.isArray(result.episodes)
      ? result.episodes.filter((episode): episode is JsonObject => isObject(episode))
      : [];
  }

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

  async getEpisodesByRef(
    groupId: string,
    refs: { uuids?: string[]; names?: string[] },
  ): Promise<JsonObject[]> {
    const result = await this.callTool("get_episodes_by_ref", {
      group_id: groupId,
      uuids: refs.uuids ?? [],
      names: refs.names ?? [],
    });
    if (typeof result.error === "string") throw new McpToolResultError(result.error);
    return Array.isArray(result.episodes)
      ? result.episodes.filter((episode): episode is JsonObject => isObject(episode))
      : [];
  }

  /** Fold a duplicate entity into the name it is a variant of. */
  async mergeEntities(
    groupId: string,
    duplicateName: string,
    canonicalName: string,
    dryRun: boolean,
  ): Promise<JsonObject> {
    const result = await this.callTool("merge_entities", {
      group_id: groupId,
      duplicate_name: duplicateName,
      canonical_name: canonicalName,
      dry_run: dryRun,
    });
    if (typeof result.error === "string") throw new McpToolResultError(result.error);
    return result;
  }

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
    return { facts: list(result.facts), entities: list(result.entities), episodes: list(result.episodes) };
  }

  async searchFacts(
    query: string,
    groupId: string,
    limit: number,
    tuning: {
      pool?: number;
      rerank?: boolean;
      minScore?: number | null;
      contextMinScore?: number | null;
      minSpread?: number | null;
      vectorMinScore?: number | null;
      focus?: string;
    } = {},
  ): Promise<{ facts: JsonObject[]; rankedBy: string }> {
    const args: JsonObject = {
      query,
      group_ids: groupId,
      max_facts: limit,
    };
    // Sent only when configured, so an unset deployment produces the request it
    // produced before any of this existed.
    if (tuning.pool && tuning.pool > 0) args.pool = tuning.pool;
    if (tuning.rerank) args.rerank = true;
    if (typeof tuning.minScore === "number") args.min_score = tuning.minScore;
    if (typeof tuning.contextMinScore === "number") {
      args.context_min_score = tuning.contextMinScore;
    }
    // Sent whether or not anything reranks: this floor decides what the database
    // hands over, and everything downstream only re-sorts what got out.
    if (typeof tuning.minSpread === "number") {
      args.min_spread = tuning.minSpread;
    }
    if (typeof tuning.vectorMinScore === "number") {
      args.vector_min_score = tuning.vectorMinScore;
    }
    // Bounded like the query is. The focus is a whole message, and a pasted wall of
    // text went to the cross-encoder unabridged -- which is what used to return HTTP
    // 500 from the local reranker on a single long pair.
    if (tuning.rerank && tuning.focus) args.focus = tuning.focus.slice(0, FOCUS_MAX_CHARS);

    const result = await this.callTool("search_memory_facts", args);
    if (typeof result.error === "string") throw new Error(result.error);
    return {
      facts: Array.isArray(result.facts)
        ? result.facts.filter((fact): fact is JsonObject => isObject(fact))
        : [],
      // Which scale the scores are on. Two passes rank on scales that are not
      // comparable, and a floor read against the wrong one is how a threshold came
      // to sit three times below its own noise and stay there.
      rankedBy: typeof result.ranked_by === "string" ? result.ranked_by : "unknown",
    };
  }

  private async callToolOnce(name: string, args: JsonObject): Promise<JsonObject> {
    await this.ensureInitialized();
    const response = await this.rpc("tools/call", { name, arguments: args });
    return decodeToolResult(response.result);
  }

  private async callTool(name: string, args: JsonObject): Promise<JsonObject> {
    await this.ensureInitialized();

    let response: JsonRpcResponse;
    try {
      response = await this.rpc("tools/call", { name, arguments: args });
    } catch (error) {
      if (isClientClosedError(error)) throw error;
      // Read-only calls may safely repair a lost MCP session and retry once.
      if (!this.initialized || !/404|session/i.test(errorMessage(error))) throw error;
      this.resetSession();
      await this.ensureInitialized();
      response = await this.rpc("tools/call", { name, arguments: args });
    }
    return decodeToolResult(response.result);
  }

  private async ensureInitialized(): Promise<void> {
    this.assertOpen();
    if (this.initialized) return;
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
        clientInfo: { name: "graphiti-openclaw-plugin", version: "0.4.0" },
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
      throw new McpJsonRpcError(
        typeof response.error.message === "string" ? response.error.message : `MCP ${method} failed`,
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
    this.assertOpen();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const closeRequest = () => controller.abort();
    this.lifecycle.signal.addEventListener("abort", closeRequest, { once: true });

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
          .map(([key, value]) => `${key}: ${value}`)
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
      if (this.lifecycle.signal.aborted) throw new McpClientClosedError();
      if (controller.signal.aborted) {
        throw new Error(`Graphiti MCP request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.lifecycle.signal.removeEventListener("abort", closeRequest);
    }
  }
}
