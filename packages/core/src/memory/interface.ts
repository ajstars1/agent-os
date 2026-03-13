import type { Message, Conversation, ChannelType } from '@agent-os/shared';

export interface IMemoryStore {
  getOrCreateConversation(channel: ChannelType, channelId: string): Conversation;
  ensureConversation(id: string, channel?: ChannelType): void;
  addMessage(conversationId: string, msg: Omit<Message, 'id' | 'createdAt'>): Message;
  getMessages(conversationId: string, limit?: number): Message[];
  clearConversation(conversationId: string): void;
  close(): void;
}

/**
 * Represents a discrete unit of memory content.
 * Optional neurosymbolic fields support the Neurosymbolic engine pipeline.
 */
export interface MemoryChunk {
  /** Unique identifier for this chunk. */
  id: string;
  /** The raw text content of this chunk. */
  content: string;
  /** ISO-8601 timestamp of when the chunk was created. */
  createdAt: string;
  /**
   * Semantic role of this chunk within the symbolic reasoning graph
   * (e.g. "premise", "hypothesis", "observation").
   */
  logicalRole?: string;
  /**
   * Attention weight derived from the Epanechnikov kernel function.
   * Range [0, 1] — higher values indicate stronger contextual relevance.
   */
  epanechnikovWeight?: number;
}

/**
 * Captures the real-time neural state produced by the
 * AstroSymbolicEpisodic layer for a given session.
 */
export interface NeuralState {
  /** Current astrocyte modulation level (continuous, unbounded). */
  astrocyteLevel: number;
  /** Ordered list of token/context strings currently within the active context window. */
  currentContextWindow: string[];
}

