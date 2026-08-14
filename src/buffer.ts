import type { ParticipantConfig } from "./config.js";

export type MessageRole = "user" | "assistant";

export type BufferMessage = {
  role: MessageRole;
  text: string;
};

export type Buffer = {
  sessionKey: string;
  messages: BufferMessage[];
  createdAt: number;
  lastActivityAt: number;
};

export type QueueEntry = {
  buffer: Buffer;
  enqueuedAt: number;
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

/**
 * Внутренняя константа интервала проверки буферов.
 * Равна минимальному валидному bufferTimeout (30000 мс). НЕ публичный конфиг.
 */
export const CHECK_INTERVAL_MS = 30_000;

/**
 * Движок буферов и очередей v0.2 (BUFFER_SPEC.md).
 *
 * - Буфер на каждую сессию (sessionKey) внутри агента (agentId).
 * - Очередь FIFO на агента.
 * - Буфер отцепляется в очередь по лимиту (bufferLimit) или таймауту
 *   неактивности (bufferTimeout). Eligibility: минимум 2 сообщения.
 * - Внутри агента очередь processится строго последовательно (FIFO),
 *   между агентами — параллельно.
 * - При ошибке отправки буфер удаляется и НЕ возвращается в очередь (нет retry).
 */
export class BufferEngine {
  private readonly agents = new Map<string, AgentCaptureState>();
  private readonly timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly participants: ParticipantConfig[],
    private readonly bufferLimit: number,
    private readonly bufferTimeout: number,
    private readonly sink: AgentSink,
    private readonly opts: {
      now?: () => number;
      checkIntervalMs?: number;
      notifyError?: (agentId: string, sessionKey: string, reason: FlushReason, error: Error) => void;
    } = {},
  ) {
    const interval = opts.checkIntervalMs ?? CHECK_INTERVAL_MS;
    if (interval > 0) {
      this.timer = setInterval(() => {
        this.tick().catch((error: unknown) => {
          // Tick-обработка не должна ронять процесс из-за одной ошибки.
          this.opts.notifyError?.("__tick__", "", "timeout", asError(error));
        });
      }, interval);
      this.timer.unref?.();
    }
  }

  addMessage(agentId: string, sessionKey: string, role: MessageRole, text: string): void {
    const agent = this.ensureAgent(agentId);
    let buffer = agent.activeBuffers.get(sessionKey);

    if (!buffer) {
      buffer = {
        sessionKey,
        messages: [],
        createdAt: this.opts.now?.() ?? Date.now(),
        lastActivityAt: this.opts.now?.() ?? Date.now(),
      };
      agent.activeBuffers.set(sessionKey, buffer);
    }

    // Проверка триггера ПЕРЕД добавлением нового сообщения (BUFFER_SPEC):
    // лимит заполнен или таймаут уже сработал.
    const now = this.opts.now?.() ?? Date.now();
    const limitHit = buffer.messages.length >= this.bufferLimit;
    const timeoutHit = now - buffer.lastActivityAt >= this.bufferTimeout;

    if (limitHit || timeoutHit) {
      // Отцепляем существующий буфер, ТОЛЬКО если он элиджибл (>=2 сообщений).
      if (this.eligibility(buffer)) {
        agent.queue.push({ buffer, enqueuedAt: now });
        void this.pump(agent);
      }
      // Буфер с 0/1 сообщением НЕ отцепляется и НЕ заменяется: в него же добавляем.
      // Первое сообщение всегда просто добавляется в буфер, никаких триггеров.
      if (!this.eligibility(buffer)) {
        buffer.messages.push({ role, text });
        buffer.lastActivityAt = now;
        return;
      }
      // Элиджибл буфер: ушёл в очередь, открываем свежий для новых сообщений.
      buffer = {
        sessionKey,
        messages: [],
        createdAt: now,
        lastActivityAt: now,
      };
      agent.activeBuffers.set(sessionKey, buffer);
    }

    buffer.messages.push({ role, text });
    buffer.lastActivityAt = now;
  }

  /** Буфер — эпизод только если в нём минимум 2 сообщения (BUFFER_SPEC eligibility). */
  private eligibility(buffer: Buffer): boolean {
    return buffer.messages.length >= 2;
  }

  private ensureAgent(agentId: string): AgentCaptureState {
    let agent = this.agents.get(agentId);
    if (!agent) {
      agent = { agentId, activeBuffers: new Map(), queue: [], processing: false };
      this.agents.set(agentId, agent);
    }
    return agent;
  }

  private async tick(): Promise<void> {
    const now = this.opts.now?.() ?? Date.now();
    for (const agent of this.agents.values()) {
      for (const [sessionKey, buffer] of agent.activeBuffers) {
        if (buffer.messages.length === 0) continue;
        const elapsed = now - buffer.lastActivityAt;
        if (elapsed >= this.bufferTimeout) {
          if (this.eligibility(buffer)) {
            // Буфер с >= 2 сообщениями отцепляем в очередь.
            agent.activeBuffers.delete(sessionKey);
            agent.queue.push({ buffer, enqueuedAt: now });
          }
          // Буфер с 0/1 сообщением НЕ отцепляется по таймауту (BUFFER_SPEC):
          // он продолжает ждать второго сообщения, activeBuffers не трогаем.
        }
      }
      void this.pump(agent);
    }
  }

  private async pump(agent: AgentCaptureState): Promise<void> {
    if (agent.processing) return;
    agent.processing = true;
    try {
      // Процессим до опустошения (BUFFER_SPEC: за один тик вся очередь агента).
      while (agent.queue.length > 0) {
        const entry = agent.queue[0];
        const reason = this.detectReason(entry);
        try {
          await this.sink(agent.agentId, entry, reason);
          agent.queue.shift();
        } catch (error) {
          // Ошибка: буфер удаляется, НЕ возвращается в очередь (нет retry/carousel).
          agent.queue.shift();
          this.opts.notifyError?.(agent.agentId, entry.buffer.sessionKey, reason, asError(error));
        }
      }
    } finally {
      agent.processing = false;
    }
  }

  private detectReason(entry: QueueEntry): FlushReason {
    // Причина отцепления: лимит — если буфер заполнен до предела (>= bufferLimit),
    // иначе таймаут. Причина фиксируется в момент enqueue на основе состояния буфера.
    return entry.buffer.messages.length >= this.bufferLimit ? "limit" : "timeout";
  }

  /** Активная (живая) очередь всех агентов — для диагностики. */
  queueLength(): number {
    let total = 0;
    for (const state of this.agents.values()) total += state.queue.length;
    return total;
  }

  /** Количество живых буферов по агенту. */
  activeBufferCount(agentId: string): number {
    return this.agents.get(agentId)?.activeBuffers.size ?? 0;
  }

  getParticipants(): ParticipantConfig[] {
    return this.participants;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
