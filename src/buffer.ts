export { CHECK_INTERVAL_SEC, MIN_BUFFER_TIMEOUT_SEC } from "./capture-constants.js";

/** Shared capture data shapes. The live engine is DurableBufferEngine. */
export type MessageRole = "user" | "assistant";
export type BufferMessage = { role: MessageRole; text: string };
export type EpisodeJson = {
  participants: { user: string; assistant: string };
  messages: BufferMessage[];
};
export type Buffer = {
  sessionKey: string;
  messages: BufferMessage[];
  episode: EpisodeJson;
  createdAt: number;
  lastActivityAt: number;
};
export type FlushReason = "limit" | "timeout";
export type EpisodeIdentity = {
  uuid: string;
  name: string;
  batchNumber: number;
  previousEpisodeUuid?: string;
  submittedAt: number;
};
export type QueueEntry = {
  buffer: Buffer;
  enqueuedAt: number;
  reason: FlushReason;
  episode?: EpisodeIdentity;
  identityRestored?: boolean;
};
export type PersistedBuffer = {
  sessionKey: string;
  participants: { user: string; assistant: string };
  messages: BufferMessage[];
  createdAt: number;
  lastActivityAt: number;
};
export type PersistedQueueEntry = {
  buffer: PersistedBuffer;
  enqueuedAt: number;
  reason: FlushReason;
  episode?: EpisodeIdentity;
};
export type PersistedAgentCaptureState = {
  agentId: string;
  activeBuffers: PersistedBuffer[];
  queue: PersistedQueueEntry[];
};
