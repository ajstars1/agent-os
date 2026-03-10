import { randomUUID } from 'node:crypto';
export class InMemoryStore {
    conversations = new Map();
    messagesByConv = new Map();
    getOrCreateConversation(channel, channelId) {
        const key = `${channel}:${channelId}`;
        const existing = this.conversations.get(key);
        if (existing)
            return existing;
        const conv = {
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
    addMessage(conversationId, msg) {
        const full = {
            id: randomUUID(),
            createdAt: new Date().toISOString(),
            ...msg,
        };
        const list = this.messagesByConv.get(conversationId) ?? [];
        list.push(full);
        this.messagesByConv.set(conversationId, list);
        return full;
    }
    getMessages(conversationId, limit = 50) {
        const all = this.messagesByConv.get(conversationId) ?? [];
        return all.slice(-limit);
    }
    clearConversation(conversationId) {
        this.messagesByConv.set(conversationId, []);
    }
    close() {
        // no-op
    }
}
//# sourceMappingURL=memory.js.map