import type { Message, Conversation, ChannelType } from '@agent-os/shared';
import type { IMemoryStore } from './interface.js';
export declare class SQLiteMemoryStore implements IMemoryStore {
    private readonly db;
    constructor(dbPath: string);
    private migrate;
    getOrCreateConversation(channel: ChannelType, channelId: string): Conversation;
    addMessage(conversationId: string, msg: Omit<Message, 'id' | 'createdAt'>): Message;
    getMessages(conversationId: string, limit?: number): Message[];
    clearConversation(conversationId: string): void;
    close(): void;
}
//# sourceMappingURL=sqlite.d.ts.map