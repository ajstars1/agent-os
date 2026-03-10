import { randomUUID } from 'node:crypto';
import type { IMemoryStore } from '../../memory/interface.js';
import type { Message, Conversation, ChannelType } from '@agent-os/shared';

export class InMemoryStore implements IMemoryStore {
  private readonly conversations = new Map<string, Conversation>();
  private readonly messagesByConv = new Map<string, Message[]>();

  getOrCreateConversation(channel: ChannelType, channelId: string): Conversation {
    const key = `${channel}:${channelId}`;
    const existing = this.conversations.get(key);
    if (existing) return existing;
    const conv: Conversation = {
      id: randomUUID(),
      channel,
      channelId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.conversations.set(key, conv);
    this.messagesByConv.set(conv.id, []);
    return conv;
  }

  addMessage(conversationId: string, msg: Omit<Message, 'id' | 'createdAt'>): Message {
    const full: Message = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...msg,
    };
    const list = this.messagesByConv.get(conversationId) ?? [];
    list.push(full);
    this.messagesByConv.set(conversationId, list);
    return full;
  }

  getMessages(conversationId: string, limit = 50): Message[] {
    const all = this.messagesByConv.get(conversationId) ?? [];
    return all.slice(-limit);
  }

  clearConversation(conversationId: string): void {
    this.messagesByConv.set(conversationId, []);
  }

  close(): void {
    // no-op
  }
}
