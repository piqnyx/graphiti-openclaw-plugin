import type { AgentActors } from "./config.js";
import { DEFAULT_ACTORS } from "./config.js";
import { CHECK_INTERVAL_SEC, MIN_BUFFER_TIMEOUT_SEC } from "./capture-constants.js";

export { CHECK_INTERVAL_SEC, MIN_BUFFER_TIMEOUT_SEC } from "./capture-constants.js";

export type MessageRole = "user" | "assistant";
export type BufferMessage = { role: MessageRole; text: string };
export type EpisodeJson = { participants: { user: string; assistant: string }; messages: BufferMessage[] };
export type Buffer = { sessionKey: string; messages: BufferMessage[]; episode: EpisodeJson; createdAt: number; lastActivityAt: number };
export type FlushReason = "limit" | "timeout";
export type EpisodeIdentity = { uuid: string; name: string; batchNumber: number; previousEpisodeUuid?: string; submittedAt: number };
export type QueueEntry = { buffer: Buffer; enqueuedAt: number; reason: FlushReason; episode?: EpisodeIdentity; identityRestored?: boolean };
export type AgentCaptureState = { agentId: string; activeBuffers: Map<string, Buffer>; queue: QueueEntry[]; processing: boolean; retryAfter: number; failureActive: boolean };
export type PersistedBuffer = { sessionKey: string; participants: { user: string; assistant: string }; messages: BufferMessage[]; createdAt: number; lastActivityAt: number };
export type PersistedQueueEntry = { buffer: PersistedBuffer; enqueuedAt: number; reason: FlushReason; episode?: EpisodeIdentity };
export type PersistedAgentCaptureState = { agentId: string; activeBuffers: PersistedBuffer[]; queue: PersistedQueueEntry[] };
export type BufferEngineSnapshot = { agents: PersistedAgentCaptureState[] };
export type AgentSink = (agentId: string, entry: QueueEntry, reason: FlushReason) => Promise<void>;

function cloneMessages(messages: readonly BufferMessage[]): BufferMessage[] { return messages.map((message) => ({ ...message })); }
function persistBuffer(buffer: Buffer): PersistedBuffer { return { sessionKey: buffer.sessionKey, participants: { ...buffer.episode.participants }, messages: cloneMessages(buffer.messages), createdAt: buffer.createdAt, lastActivityAt: buffer.lastActivityAt }; }
function restoreBuffer(buffer: PersistedBuffer): Buffer { const messages = cloneMessages(buffer.messages); return { sessionKey: buffer.sessionKey, messages, episode: { participants: { ...buffer.participants }, messages }, createdAt: buffer.createdAt, lastActivityAt: buffer.lastActivityAt }; }

/** Disk-authoritative per-session buffers feeding one FIFO per agent. */
export class BufferEngine {
  private readonly captureStates = new Map<string, AgentCaptureState>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly bufferTimeoutMs: number;
  private readonly pendingPumps = new Set<string>();
  private stopped = false;
  private persistFailureActive = false;

  constructor(
    private readonly agents: Record<string, AgentActors>,
    private readonly bufferLimit: number,
    bufferTimeoutSec: number,
    private readonly sink: AgentSink,
    private readonly opts: {
      notifyError?: (agentId: string, sessionKey: string, reason: FlushReason, error: Error) => void;
      notifyRecovered?: (agentId: string, sessionKey: string, reason: FlushReason) => void;
      onStateChange?: (snapshot: BufferEngineSnapshot) => void;
      notifyPersistError?: (error: Error) => void;
      notifyPersistRecovered?: () => void;
      initialState?: BufferEngineSnapshot;
    } = {},
  ) {
    if (!Number.isInteger(bufferLimit) || bufferLimit < 1) throw new Error("bufferLimit must be an integer >= 1 message");
    if (!Number.isInteger(bufferTimeoutSec) || bufferTimeoutSec < MIN_BUFFER_TIMEOUT_SEC) throw new Error(`bufferTimeout must be an integer >= ${MIN_BUFFER_TIMEOUT_SEC} seconds`);
    this.bufferTimeoutMs = bufferTimeoutSec * 1000;
    if (opts.initialState) this.restore(opts.initialState);
    this.timer = setInterval(() => { this.tick().catch((error: unknown) => { this.opts.notifyError?.("__tick__", "", "timeout", asError(error)); }); }, CHECK_INTERVAL_SEC * 1000);
    this.timer.unref?.();
  }

  addMessage(agentId: string, sessionKey: string, role: MessageRole, text: string): void {
    if (this.stopped) throw new Error("cannot add capture messages after BufferEngine shutdown");
    this.appendMessage(agentId, sessionKey, role, text);
    this.checkpoint();
  }

  /** Stage one complete transcript delta. Caller advances its watermark, then checkpoints once. */
  addMessages(agentId: string, sessionKey: string, messages: readonly BufferMessage[]): void {
    if (this.stopped) throw new Error("cannot add capture messages after BufferEngine shutdown");
    for (const message of messages) this.appendMessage(agentId, sessionKey, message.role, message.text);
  }

  private appendMessage(agentId: string, sessionKey: string, role: MessageRole, text: string): void {
    const clean = text.trim(); if (!clean) return;
    const agent = this.ensureAgent(agentId);
    let buffer = agent.activeBuffers.get(sessionKey);
    if (!buffer) { buffer = this.createBuffer(sessionKey, agentId); agent.activeBuffers.set(sessionKey, buffer); }
    const now = Date.now();
    if (now - buffer.lastActivityAt >= this.bufferTimeoutMs && this.isNonEmpty(buffer)) {
      agent.queue.push({ buffer, enqueuedAt: now, reason: "timeout" }); this.pendingPumps.add(agentId);
      buffer = this.createBuffer(sessionKey, agentId); agent.activeBuffers.set(sessionKey, buffer);
    }
    buffer.messages.push({ role, text: clean }); buffer.lastActivityAt = now;
    if (buffer.messages.length >= this.bufferLimit) {
      agent.queue.push({ buffer, enqueuedAt: now, reason: "limit" }); agent.activeBuffers.set(sessionKey, this.createBuffer(sessionKey, agentId)); this.pendingPumps.add(agentId);
    }
  }

  private actorsFor(agentId: string): AgentActors { return this.agents[agentId] ?? DEFAULT_ACTORS; }
  private createBuffer(sessionKey: string, agentId: string): Buffer { const now = Date.now(); const actors = this.actorsFor(agentId); const episode: EpisodeJson = { participants: { user: actors.user, assistant: actors.assistant }, messages: [] }; return { sessionKey, messages: episode.messages, episode, createdAt: now, lastActivityAt: now }; }
  private isNonEmpty(buffer: Buffer): boolean { return buffer.messages.length > 0; }
  private ensureAgent(agentId: string): AgentCaptureState { let agent = this.captureStates.get(agentId); if (!agent) { agent = { agentId, activeBuffers: new Map(), queue: [], processing: false, retryAfter: 0, failureActive: false }; this.captureStates.set(agentId, agent); } return agent; }

  private restore(snapshot: BufferEngineSnapshot): void {
    for (const persisted of snapshot.agents) {
      const agent = this.ensureAgent(persisted.agentId);
      for (const storedBuffer of persisted.activeBuffers) { const buffer = restoreBuffer(storedBuffer); if (!this.isNonEmpty(buffer)) continue; if (agent.activeBuffers.has(buffer.sessionKey)) throw new Error(`capture snapshot contains duplicate active buffer for ${persisted.agentId}/${buffer.sessionKey}`); agent.activeBuffers.set(buffer.sessionKey, buffer); }
      agent.queue.push(...persisted.queue.filter((entry) => entry.buffer.messages.length > 0).map((entry) => ({ buffer: restoreBuffer(entry.buffer), enqueuedAt: entry.enqueuedAt, reason: entry.reason, ...(entry.episode ? { episode: { ...entry.episode }, identityRestored: true } : {}) })));
      if (agent.queue.length > 0) this.pendingPumps.add(agent.agentId);
    }
  }

  resumeRestored(): void { if (this.stopped) return; void this.tick().catch((error: unknown) => { this.opts.notifyError?.("__tick__", "", "timeout", asError(error)); }); }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now(); let changed = false;
    for (const agent of this.captureStates.values()) for (const [sessionKey, buffer] of agent.activeBuffers) if (this.isNonEmpty(buffer) && now - buffer.lastActivityAt >= this.bufferTimeoutMs) { agent.activeBuffers.delete(sessionKey); agent.queue.push({ buffer, enqueuedAt: now, reason: "timeout" }); this.pendingPumps.add(agent.agentId); changed = true; }
    const durable = changed || this.persistFailureActive ? this.persistState() : true; if (!durable) return;
    this.flushPendingPumps(); for (const agent of this.captureStates.values()) void this.pump(agent);
  }

  private async pump(agent: AgentCaptureState): Promise<void> {
    if (this.stopped || this.persistFailureActive || agent.processing || Date.now() < agent.retryAfter) return;
    agent.processing = true;
    try {
      while (!this.stopped && !this.persistFailureActive && agent.queue.length > 0) {
        const entry = agent.queue[0]!; const reason = entry.reason;
        try { await this.sink(agent.agentId, entry, reason); }
        catch (error) { agent.retryAfter = Date.now() + CHECK_INTERVAL_SEC * 1000; if (!agent.failureActive) this.opts.notifyError?.(agent.agentId, entry.buffer.sessionKey, reason, asError(error)); agent.failureActive = true; break; }
        if (this.stopped) { this.persistState(); break; }
        agent.queue.shift(); if (!this.persistState()) break;
        if (agent.failureActive) this.opts.notifyRecovered?.(agent.agentId, entry.buffer.sessionKey, reason);
        agent.failureActive = false; agent.retryAfter = 0;
      }
    } finally { agent.processing = false; }
  }

  private flushPendingPumps(): void { if (this.stopped || this.persistFailureActive) return; const ids = [...this.pendingPumps]; this.pendingPumps.clear(); for (const agentId of ids) { const agent = this.captureStates.get(agentId); if (agent) void this.pump(agent); } }
  queueLength(): number { let total = 0; for (const state of this.captureStates.values()) total += state.queue.length; return total; }
  activeBufferCount(agentId: string): number { return this.captureStates.get(agentId)?.activeBuffers.size ?? 0; }
  snapshot(): BufferEngineSnapshot { const agents: PersistedAgentCaptureState[] = []; for (const state of this.captureStates.values()) { const activeBuffers = [...state.activeBuffers.values()].filter((buffer) => this.isNonEmpty(buffer)).map(persistBuffer); const queue = state.queue.map((entry) => ({ buffer: persistBuffer(entry.buffer), enqueuedAt: entry.enqueuedAt, reason: entry.reason, ...(entry.episode ? { episode: { ...entry.episode } } : {}) })); if (activeBuffers.length === 0 && queue.length === 0) continue; agents.push({ agentId: state.agentId, activeBuffers, queue }); } return { agents }; }
  isStopped(): boolean { return this.stopped; }

  /** Persist staged state before any eligible head is allowed to leave the process. */
  checkpoint(): boolean { const durable = this.persistState(); if (durable) this.flushPendingPumps(); return durable; }
  private persistState(): boolean { const onStateChange = this.opts.onStateChange; if (!onStateChange) return true; try { onStateChange(this.snapshot()); } catch (error) { if (!this.persistFailureActive) { this.persistFailureActive = true; this.opts.notifyPersistError?.(asError(error)); } return false; } if (this.persistFailureActive) { this.persistFailureActive = false; this.opts.notifyPersistRecovered?.(); } return true; }

  async shutdown(graceMs = 4_000): Promise<void> { if (!this.stopped) { this.stopped = true; clearInterval(this.timer); this.persistState(); } const deadline = Date.now() + Math.max(0, graceMs); while ([...this.captureStates.values()].some((state) => state.processing)) { if (Date.now() >= deadline) break; await new Promise((resolve) => setTimeout(resolve, 10)); } this.persistState(); }
  stop(): void { if (this.stopped) return; this.stopped = true; clearInterval(this.timer); this.persistState(); }
}
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
