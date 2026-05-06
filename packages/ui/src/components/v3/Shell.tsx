'use client';

import { useEffect, useRef } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { CrewPanel } from './CrewPanel';
import { ChatInput } from './ChatInput';
import { MessageBubble } from './MessageBubble';
import { StreamingBubble } from './StreamingBubble';
import { EmptyState } from './EmptyState';
import { useChat } from '@/lib/useChat';

const SUGGESTIONS = [
  'explain this codebase',
  'fix the failing tests',
  'plan a new feature',
  'review my latest changes',
  'brainstorm app ideas',
];

export function Shell() {
  const chat = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new content arrives
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [chat.messages.length, chat.streaming?.content.length]);

  // Esc to cancel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && chat.isStreaming) chat.cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chat]);

  const lastAssistant = [...chat.messages].reverse().find((m) => m.role === 'assistant');
  const provider = chat.streaming?.provider ?? lastAssistant?.provider ?? 'claude';
  const model    = chat.streaming?.model    ?? lastAssistant?.model    ?? 'agent-os';
  const isEmpty  = chat.messages.length === 0 && !chat.streaming;

  return (
    <div className="fixed inset-0 flex flex-col">
      {/* Header */}
      <Header
        model={model}
        provider={provider}
        sessionCostUsd={undefined}
        onNewChat={chat.newConversation}
      />

      {/* Main grid */}
      <div className="flex-1 flex min-h-0">
        <Sidebar active="chat" />

        {/* Center column */}
        <main className="flex-1 flex flex-col min-w-0">
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 pt-3">
            {isEmpty ? (
              <EmptyState onSend={chat.send} />
            ) : (
              <div className="max-w-3xl mx-auto pb-6">
                <AnimatePresence initial={false}>
                  {chat.messages.map((m) => (
                    <MessageBubble key={m.id} message={m} />
                  ))}
                </AnimatePresence>

                {chat.streaming && (
                  <StreamingBubble
                    content={chat.streaming.content}
                    provider={chat.streaming.provider}
                    model={chat.streaming.model}
                  />
                )}
              </div>
            )}
          </div>

          {/* Input */}
          <ChatInput
            onSend={chat.send}
            onCancel={chat.cancel}
            isStreaming={chat.isStreaming}
            suggestions={isEmpty ? [] : SUGGESTIONS}
          />
        </main>

        <CrewPanel
          workers={chat.workers}
          isStreaming={chat.isStreaming}
          sessionTokens={chat.sessionTokens}
        />
      </div>
    </div>
  );
}
