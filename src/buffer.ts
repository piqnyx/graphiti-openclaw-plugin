import type { AgentActors } from "./config.js";
import { DEFAULT_ACTORS } from "./config.js";

export type MessageRole = "user" | "assistant";

export type BufferMessage = {
  role: MessageRole;
  text: string;
};

/**
 * Пустой JSON-эпизод создаётся вместе с буфером (Lifecycle JSON, json-format.md):
 * `participants` (канонические имена акторов агента) присутствуют, `messages` = `[]`.
 * Сообщения наталкиваются в `messages` по мере добавления. Текст НЕ переписывается
 * (никаких алиасов-регулярок) — Graphiti получает реальные сообщения как есть.
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
  lastActivityAt: number; // timestamp последнего сообщения (мс)
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

/**
 * Внутренняя константа интервала проверки буферов.
 * Равна минимальному валидному bufferTimeout = 30 секунд. НЕ публичный конфиг.
 */
export const CHECK_INTERVAL_SEC = 30;

/**
 * Движок буферов и очередей v0.2 (BUFFER_SPEC.md).
 *
 * - Буфер на каждую сессию (sessionKey) внутри агента (agentId).
 * - Очередь FIFO на агента.
 * - Буфер отцепляется в очередь по лимиту (bufferLimit) или таймауту
 *   неактивности (bufferTimeout, в секундах). Eligibility: минимум 2 сообщения.
 * - Пустой JSON (акторы агента + messages=[]) создаётся вместе с буфером;
 *   сообщения наталкиваются в него при добавлении (без переписывания текста).
 * - Внутри агента очередь processится строго последовательно (FIFO),
 *   между агентами — параллельно.
 * - При ошибке отправки буфер удаляется и НЕ возвращается в очередь (нет retry).
 */
export class BufferEngine {
  private readonly captureStates = new Map<string, AgentCaptureState>();
  private readonly timer: ReturnType<typeof setInterval> | null = null;
  private readonly bufferTimeoutMs: number;

  constructor(
    // Канонические имена акторов ПО АГЕНТАМ (мультиагент).
    private readonly agents: Record<string, AgentActors>,
    private readonly bufferLimit: number,
    bufferTimeoutSec: number, // в секундах (конфиг); внутри конвертируем в мс
    private readonly sink: AgentSink,
    private readonly opts: {
      notifyError?: (agentId: string, sessionKey: string, reason: FlushReason, error: Error) => void;
    } = {},
  ) {
    this.bufferTimeoutMs = bufferTimeoutSec * 1000;
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => {
        // Tick-обработка не должна ронять процесс из-за одной ошибки.
        this.opts.notifyError?.("__tick__", "", "timeout", asError(error));
      });
    }, CHECK_INTERVAL_SEC * 1000);
    this.timer.unref?.();
  }

  addMessage(agentId: string, sessionKey: string, role: MessageRole, text: string): void {
    const agent = this.ensureAgent(agentId);
    let buffer = agent.activeBuffers.get(sessionKey);

    if (!buffer) {
      buffer = this.createBuffer(sessionKey, agentId);
      agent.activeBuffers.set(sessionKey, buffer);
    }

    const now = Date.now();

    // Таймаут: если буфер давно простаивал И в нём уже есть пара — отцепляем
    // его до добавления нового сообщения (это «застрявший» буфер, страховка).
    const timeoutHit = now - buffer.lastActivityAt >= this.bufferTimeoutMs;
    if (timeoutHit && this.eligibility(buffer)) {
      agent.queue.push({ buffer, enqueuedAt: now });
      void this.pump(agent);
      buffer = this.createBuffer(sessionKey, agentId);
      agent.activeBuffers.set(sessionKey, buffer);
    }

    // Добавляем сообщение.
    this.pushMessage(buffer, role, text, now);

    // Лимит: если ПОСЛЕ добавления буфер достиг bufferLimit и элиджибл —
    // отцепляем его (ровно bufferLimit сообщений) и отдаём свежий буфер.
    if (buffer.messages.length >= this.bufferLimit && this.eligibility(buffer)) {
      agent.queue.push({ buffer, enqueuedAt: now });
      void this.pump(agent);
      const next = this.createBuffer(sessionKey, agentId);
      agent.activeBuffers.set(sessionKey, next);
    }
  }

  /** Канонические имена акторов для агента (fallback на User/Assistant). */
  private actorsFor(agentId: string): AgentActors {
    return this.agents[agentId] ?? DEFAULT_ACTORS;
  }

  /** Создаёт буфер с пустым JSON-эпизодом (акторы агента есть, messages=[]). */
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

  /** Наталкивает сообщение в JSON буфера без переписывания текста. */
  private pushMessage(
    buffer: Buffer,
    role: MessageRole,
    text: string,
    now: number,
  ): void {
    const message: BufferMessage = { role, text };
    // buffer.messages === buffer.episode.messages (одна ссылка, см. createBuffer),
    // поэтому достаточно одного push — JSON обновится автоматически.
    buffer.messages.push(message);
    buffer.lastActivityAt = now;
  }

  /** Буфер — эпизод только если в нём минимум 2 сообщения (BUFFER_SPEC eligibility). */
  private eligibility(buffer: Buffer): boolean {
    return buffer.messages.length >= 2;
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
        if (buffer.messages.length === 0) continue;
        const elapsed = now - buffer.lastActivityAt;
        if (elapsed >= this.bufferTimeoutMs) {
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
    // иначе таймаут.
    return entry.buffer.messages.length >= this.bufferLimit ? "limit" : "timeout";
  }

  /** Активная (живая) очередь всех агентов — для диагностики. */
  queueLength(): number {
    let total = 0;
    for (const state of this.captureStates.values()) total += state.queue.length;
    return total;
  }

  /** Количество живых буферов по агенту. */
  activeBufferCount(agentId: string): number {
    return this.captureStates.get(agentId)?.activeBuffers.size ?? 0;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
