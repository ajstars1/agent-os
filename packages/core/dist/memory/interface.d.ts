import type { Message, Conversation, ChannelType } from '@agent-os/shared';
export interface IMemoryStore {
    getOrCreateConversation(channel: ChannelType, channelId: string): Conversation;
    addMessage(conversationId: string, msg: Omit<Message, 'id' | 'createdAt'>): Message;
    getMessages(conversationId: string, limit?: number): Message[];
    clearConversation(conversationId: string): void;
    close(): void;
}
//# sourceMappingURL=interface.d.ts.map