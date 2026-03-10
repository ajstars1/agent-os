import type { IMemoryStore } from '../../memory/interface.js';
import type { Message, Conversation, ChannelType } from '@agent-os/shared';
export declare class InMemoryStore implements IMemoryStore {
    private readonly conversations;
    private readonly messagesByConv;
    getOrCreateConversation(channel: ChannelType, channelId: string): Conversation;
    addMessage(conversationId: string, msg: Omit<Message, 'id' | 'createdAt'>): Message;
    getMessages(conversationId: string, limit?: number): Message[];
    clearConversation(conversationId: string): void;
    close(): void;
}
//# sourceMappingURL=memory.d.ts.map