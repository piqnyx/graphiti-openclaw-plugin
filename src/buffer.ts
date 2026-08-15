import type { AgentActors } from "./config.js";
import { DEFAULT_ACTORS } from "./config.js";

export type MessageRole = "user" | "assistant";

export type BufferMessage = {
  role: MessageRole;
  text: string;
};

/**
 * Пустой JSON-эпизод создаётся вместе с буфером:
 * `participants` (канонические имена акторов агента) присутствуют, `messages` = `[]`.
 * Completed turn добавляется атомарно как user+assistant. Текст не переписывается.
 */
export type EpisodeJson = {
  participants: { user: string; assistant: string };
  messages: BufferMessage[];
};

export type Buffer = {
  sessionKey: string; // ключ сессии = saga ID для Graphiti
  messages: BufferMessage[]; // накопленные сообщения (== episode.messages)
  episode: EpisodeJson; // JSON, созданный вместе с буфером
  createdAt: number; // timestamp создания буфера (мс)
  lastActivityAt: number; // timestamp последнего completed turn (мс)
};

export type QueueEntry = {
  buffer: Buffer;
  enqueuedAt: number; // момент ухода буфера в очередь (мс)
};

export type FlushReason = "limit" | "timeout";

export type AgentCaptureState = {
  agentId: string;
  activeBuffers: Map<string, Buffer>;
  queue: QueueEntry[];
  processing: boolean;
};

export type AgentSink = (
  agentId: string,
  entry: QueueEntry,
  reason: FlushReason,
) => Promise<void>;

/** Минимальный публичный bufferTimeout, в секундах. */
export const MIN_BUFFER_TIMEOUT_SEC = 30;

/**
 * Внутренняя константа интервала проверки буферов.
 * Равна минимальному валидному bufferTimeout. Не является публичным конфигом.
 */
export const CHECK_INTERVAL_SEC = MIN_BUFFER_TIMEOUT_SEC;

/**
 * Движок буферов и очередей.
 *
 * - Буфер на каждую сессию (sessionKey) внутри агента (agentId).
 * - Одна FIFO-очередь на агента.
 * - Completed turn (user+assistant) добавляется в буфер атомарно.
 * - bufferLimit считается в сообщениях и обязан быть чётным, чтобы не разрезать turn.
 * - Буфер отцепляется по лимиту или таймауту неактивности.
 * - Внутри агента очередь processится строго последовательно; между агентами независимо.
 */
export class BufferEngine {
  private readonly captureStates = new Map<string, AgentCaptureState>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly bufferTimeoutMs: number;

  constructor(
    private readonly agents: Record<string, AgentActors>,
    private readonly bufferLimit: number,
    bufferTimeoutSec: number,
    private readonly sink: AgentSink,
    private readonly opts: {
      notifyError?: (agentId: string, sessionKey: string, reason: FlushReason, error: Error) => void;
    } = {},
  ) {
    if (!Number.isInteger(bufferLimit) || bufferLimit < 2 || bufferLimit % 2 !== 0) {
      throw new Error("bufferLimit must be an even integer >= 2 messages");
    }
    if (!Number.isInteger(bufferTimeoutSec) || bufferTimeoutSec < MIN_BUFFER_TIMEOUT_SEC) {
      throw new Error(`bufferTimeout must be an integer >= ${MIN_BUFFER_TIMEOUT_SEC} seconds`);
    }

    this.bufferTimeoutMs = bufferTimeoutSec * 1000;
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => {
        this.opts.notifyError?.("__tick__", "", "timeout", asError(error));
      });
    }, CHECK_INTERVAL_SEC * 1000);
    this.timer.unref?.();
  }

  /**
   * Добавляет один полностью завершённый ход user+assistant.
   * Частичный user никогда не существует внутри BufferEngine.
   */
  addTurn(agentId: string, sessionKey: string, userText: string, assistantText: string): void {
    const agent = this.ensureAgent(agentId);
    let buffer = agent.activeBuffers.get(sessionKey);

    if (!buffer) {
      buffer = this.createBuffer(sessionKey, agentId);
      agent.activeBuffers.set(sessionKey, buffer);
    }

    const now = Date.now();

    // Если старый буфер уже протух, отцепляем его ДО добавления нового turn.
    // Новый user+assistant целиком попадёт в свежий буфер.
    const timeoutHit = now - buffer.lastActivityAt >= this.bufferTimeoutMs;
    if (timeoutHit && this.eligibility(buffer)) {
      agent.queue.push({ buffer, enqueuedAt: now });
      void this.pump(agent);
      buffer = this.createBuffer(sessionKey, agentId);
      agent.activeBuffers.set(sessionKey, buffer);
    }

    this.pushCompletedTurn(buffer, userText, assistantText, now);

    // Чётный лимит + атомарный turn гарантируют, что батч заканчивается assistant.
    if (buffer.messages.length >= this.bufferLimit) {
      agent.queue.push({ buffer, enqueuedAt: now });
      void this.pump(agent);
      agent.activeBuffers.set(sessionKey, this.createBuffer(sessionKey, agentId));
    }
  }

  /** Канонические имена акторов для агента (fallback на User/Assistant). */
  private actorsFor(agentId: string): AgentActors {
    return this.agents[agentId] ?? DEFAULT_ACTORS;
  }

  private createBuffer(sessionKey: string, agentId: string): Buffer {
    const now = Date.now();
    const actors = this.actorsFor(agentId);
    const episode: EpisodeJson = {
      participants: { user: actors.user, assistant: actors.assistant },
      messages: [],
    };
    return {
      sessionKey,
      messages: episode.messages,
      episode,
      createdAt: now,
      lastActivityAt: now,
    };
  }

  private pushCompletedTurn(
    buffer: Buffer,
    userText: string,
    assistantText: string,
    now: number,
  ): void {
    buffer.messages.push(
      { role: "user", text: userText },
      { role: "assistant", text: assistantText },
    );
    buffer.lastActivityAt = now;
  }

  private eligibility(buffer: Buffer): boolean {
    return buffer.messages.length >= 2 && buffer.messages.length % 2 === 0;
  }

  private ensureAgent(agentId: string): AgentCaptureState {
    let agent = this.captureStates.get(agentId);
    if (!agent) {
      agent = { agentId, activeBuffers: new Map(), queue: [], processing: false };
      this.captureStates.set(agentId, agent);
    }
    return agent;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const agent of this.captureStates.values()) {
      for (const [sessionKey, buffer] of agent.activeBuffers) {
        if (!this.eligibility(buffer)) continue;
        const elapsed = now - buffer.lastActivityAt;
        if (elapsed >= this.bufferTimeoutMs) {
          agent.activeBuffers.delete(sessionKey);
          agent.queue.push({ buffer, enqueuedAt: now });
        }
      }
      void this.pump(agent);
    }
  }

  private async pump(agent: AgentCaptureState): Promise<void> {
    if (agent.processing) return;
    agent.processing = true;
    try {
      while (agent.queue.length > 0) {
        const entry = agent.queue[0];
        const reason = this.detectReason(entry);
        try {
          await this.sink(agent.agentId, entry, reason);
          agent.queue.shift();
        } catch (error) {
          agent.queue.shift();
          this.opts.notifyError?.(agent.agentId, entry.buffer.sessionKey, reason, asError(error));
        }
      }
    } finally {
      agent.processing = false;
    }
  }

  private detectReason(entry: QueueEntry): FlushReason {
    return entry.buffer.messages.length >= this.bufferLimit ? "limit" : "timeout";
  }

  queueLength(): number {
    let total = 0;
    for (const state of this.captureStates.values()) total += state.queue.length;
    return total;
  }

  activeBufferCount(agentId: string): number {
    return this.captureStates.get(agentId)?.activeBuffers.size ?? 0;
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
