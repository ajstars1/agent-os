import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore } from './mocks/memory.js';

describe('InMemoryStore', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('creates a new conversation', () => {
    const conv = store.getOrCreateConversation('cli', 'proc-123');
    expect(conv.id).toBeTruthy();
    expect(conv.channel).toBe('cli');
    expect(conv.channelId).toBe('proc-123');
  });

  it('returns the same conversation on subsequent calls', () => {
    const a = store.getOrCreateConversation('cli', 'proc-123');
    const b = store.getOrCreateConversation('cli', 'proc-123');
    expect(a.id).toBe(b.id);
  });

  it('creates distinct conversations for different channels', () => {
    const a = store.getOrCreateConversation('cli', 'same-id');
    const b = store.getOrCreateConversation('discord', 'same-id');
    expect(a.id).not.toBe(b.id);
  });

  it('adds and retrieves messages in order', () => {
    const conv = store.getOrCreateConversation('cli', 'test');
    store.addMessage(conv.id, { conversationId: conv.id, role: 'user', content: 'hello' });
    store.addMessage(conv.id, { conversationId: conv.id, role: 'assistant', content: 'hi' });

    const msgs = store.getMessages(conv.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.content).toBe('hello');
    expect(msgs[1]?.content).toBe('hi');
  });

  it('respects limit in getMessages', () => {
    const conv = store.getOrCreateConversation('cli', 'limit-test');
    for (let i = 0; i < 10; i++) {
      store.addMessage(conv.id, { conversationId: conv.id, role: 'user', content: `msg ${i}` });
    }
    const msgs = store.getMessages(conv.id, 3);
    expect(msgs).toHaveLength(3);
    expect(msgs[2]?.content).toBe('msg 9');
  });

  it('clearConversation removes messages but not conversation', () => {
    const conv = store.getOrCreateConversation('cli', 'clear-test');
    store.addMessage(conv.id, { conversationId: conv.id, role: 'user', content: 'hello' });
    store.clearConversation(conv.id);

    expect(store.getMessages(conv.id)).toHaveLength(0);
    // Conversation still exists (same ID returned)
    const same = store.getOrCreateConversation('cli', 'clear-test');
    expect(same.id).toBe(conv.id);
  });

  it('addMessage returns the persisted message with id and createdAt', () => {
    const conv = store.getOrCreateConversation('cli', 'msg-test');
    const msg = store.addMessage(conv.id, {
      conversationId: conv.id,
      role: 'user',
      content: 'test',
    });
    expect(msg.id).toBeTruthy();
    expect(msg.createdAt).toBeTruthy();
    expect(msg.role).toBe('user');
  });
});
