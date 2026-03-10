'use client';

import { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import type { ChatMessage } from '@/lib/hooks/useChat';

interface ChatWindowProps {
  messages: ChatMessage[];
  isStreaming: boolean;
}

const EXAMPLE_PROMPTS = [
  'What can you help me with?',
  'Summarize the key features of this agent system.',
  'Help me debug a TypeScript error.',
  'Explain the HAM memory architecture.',
];

function EmptyState({ onPromptClick }: { onPromptClick?: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-8 px-4">
      <div className="text-center">
        <div className="w-12 h-12 rounded-2xl bg-[#7c3aed]/20 border border-[#7c3aed]/30 flex items-center justify-center mx-auto mb-4">
          <span className="text-[#a78bfa] text-xl font-bold">A</span>
        </div>
        <h2 className="text-lg font-semibold text-[#f0f0f0] mb-1">Start a conversation</h2>
        <p className="text-sm text-[#6b7280]">Ask anything — your AgentOS is ready.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-xl">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            onClick={() => onPromptClick?.(prompt)}
            className="text-left px-4 py-3 rounded-xl bg-[#111111] border border-[#1f1f1f] hover:border-[#7c3aed]/40 hover:bg-[#7c3aed]/5 text-sm text-[#9ca3af] hover:text-[#f0f0f0] transition-colors"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

function StreamingIndicator() {
  return (
    <div className="flex justify-start mb-4">
      <div className="bg-[#1a1a1a] border border-[#2d2d2d] rounded-2xl rounded-tl-md px-4 py-3 flex items-center gap-1.5">
        <div className="w-2 h-2 rounded-full bg-[#6b7280] animate-pulse-dot" />
        <div className="w-2 h-2 rounded-full bg-[#6b7280] animate-pulse-dot" />
        <div className="w-2 h-2 rounded-full bg-[#6b7280] animate-pulse-dot" />
      </div>
    </div>
  );
}

export function ChatWindow({ messages, isStreaming }: ChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  const hasMessages = messages.length > 0;
  const lastMessage = messages[messages.length - 1];
  const lastMessageIsAssistantStreaming =
    isStreaming && lastMessage?.role === 'assistant' && lastMessage.content !== '';

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      {!hasMessages ? (
        <EmptyState />
      ) : (
        <div className="max-w-3xl mx-auto">
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          {/* Show pulsing dots only if last assistant message has no content yet */}
          {isStreaming && !lastMessageIsAssistantStreaming && <StreamingIndicator />}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
