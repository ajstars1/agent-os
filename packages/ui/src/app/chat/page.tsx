'use client';

import { ChatWindow } from '@/components/chat/ChatWindow';
import { ChatInput } from '@/components/chat/ChatInput';
import { useChat } from '@/lib/hooks/useChat';

export default function ChatPage() {
  const { messages, isStreaming, sendMessage, conversationId } = useChat(null);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-[#1f1f1f] px-6 py-3 flex items-center gap-3">
        <h1 className="text-sm font-medium text-[#f0f0f0]">New Conversation</h1>
        {conversationId && (
          <span className="text-xs text-[#6b7280] font-mono">
            {conversationId.slice(0, 8)}…
          </span>
        )}
      </div>
      <ChatWindow messages={messages} isStreaming={isStreaming} />
      <ChatInput onSend={sendMessage} isDisabled={isStreaming} />
    </div>
  );
}
