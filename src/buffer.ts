import type { ParticipantConfig, ParticipantRole } from "./config.js";

export type MessageRole = "user" | "assistant";

export type BufferMessage = {
  role: MessageRole;
  text: string;
};

/**
 * Пустой JSON-эпизод создаётся вместе с буфером (Lifecycle JSON, json-format.md):
 * `participants` (акторы) присутствуют, `messages` = `[]`.
 * Сообщения нормализуются и наталкиваются в `messages` по мере добавления.
 */
export type EpisodeJson = {
  participants: Record<ParticipantRole, string>;
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
 * - Пустой JSON (акторы + messages=[]) создаётся вместе с буфером; сообщения
 *   нормализуются (алиасы) и наталкиваются в него при добавлении.
 * - Внутри агента очередь processится строго последовательно (FIFO),
 *   между агентами — параллельно.
 * - При ошибке отправки буфер удаляется и НЕ возвращается в очередь (нет retry).
 */
export class BufferEngine {
  private readonly agents = new Map<string, AgentCaptureState>();
  private readonly timer: ReturnType<typeof setInterval> | null = null;
  private readonly bufferTimeoutMs: number;
  // Алиасы-регулярки компилируются один раз при старте (json-format.md),
  // в порядке участников: user(алиасы), assistant(алиасы).
  private readonly aliasMatchers: { re: RegExp; name: string }[];

  constructor(
    private readonly participants: ParticipantConfig[],
    private readonly bufferLimit: number,
    bufferTimeoutSec: number, // в секундах (конфиг); внутри конвертируем в мс
    private readonly sink: AgentSink,
    private readonly opts: {
      notifyError?: (agentId: string, sessionKey: string, reason: FlushReason, error: Error) => void;
    } = {},
  ) {
    this.bufferTimeoutMs = bufferTimeoutSec * 1000;
    this.aliasMatchers = this.participants.flatMap((p) =>
      p.aliases
        .map((alias) => {
          try {
            return { re: new RegExp(alias, "gi"), name: p.name } as const;
          } catch {
            return null;
          }
        })
        .filter((m): m is { re: RegExp; name: string } => m !== null),
    );
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
      buffer = this.createBuffer(sessionKey);
      agent.activeBuffers.set(sessionKey, buffer);
    }

    // Проверка триггера ПЕРЕД добавлением нового сообщения (BUFFER_SPEC):
    // лимит заполнен или таймаут уже сработал.
    const now = Date.now();
    const limitHit = buffer.messages.length >= this.bufferLimit;
    const timeoutHit = now - buffer.lastActivityAt >= this.bufferTimeoutMs;

    if (limitHit || timeoutHit) {
      // Отцепляем существующий буфер, ТОЛЬКО если он элиджибл (>=2 сообщений).
      if (this.eligibility(buffer)) {
        agent.queue.push({ buffer, enqueuedAt: now });
        void this.pump(agent);
      }
      // Буфер с 0/1 сообщением НЕ отцепляется и НЕ заменяется: в него же добавляем.
      if (!this.eligibility(buffer)) {
        this.pushMessage(buffer, role, text, now);
        return;
      }
      // Элиджибл буфер: ушёл в очередь, открываем свежий с новым пустым JSON.
      buffer = this.createBuffer(sessionKey);
      agent.activeBuffers.set(sessionKey, buffer);
    }

    this.pushMessage(buffer, role, text, now);
  }

  /** Создаёт буфер с пустым JSON-эпизодом (акторы есть, messages=[]). */
  private createBuffer(sessionKey: string): Buffer {
    const now = Date.now();
    const names: Record<ParticipantRole, string> = {
      user: "user",
      assistant: "assistant",
    };
    for (const p of this.participants) names[p.role] = p.name;

    const episode: EpisodeJson = { participants: names, messages: [] };
    return {
      sessionKey,
      messages: episode.messages,
      episode,
      createdAt: now,
      lastActivityAt: now,
    };
  }

  /** Нормализует текст и наталкивает сообщение в JSON буфера. */
  private pushMessage(
    buffer: Buffer,
    role: MessageRole,
    text: string,
    now: number,
  ): void {
    const normalized = this.normalizeText(text);
    const message: BufferMessage = { role, text: normalized };
    // buffer.messages === buffer.episode.messages (одна ссылка, см. createBuffer),
    // поэтому достаточно одного push — JSON обновится автоматически.
    buffer.messages.push(message);
    buffer.lastActivityAt = now;
  }

  private normalizeText(text: string): string {
    let result = text;
    for (const matcher of this.aliasMatchers) {
      result = result.replace(matcher.re, matcher.name);
    }
    return result;
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
    const now = Date.now();
    for (const agent of this.agents.values()) {
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
    for (const state of this.agents.values()) total += state.queue.length;
    return total;
  }

  /** Количество живых буферов по агенту. */
  activeBufferCount(agentId: string): number {
    return this.agents.get(agentId)?.activeBuffers.size ?? 0;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
