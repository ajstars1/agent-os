'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { streamChat, getMessages } from '@/lib/api';
import type { MessageItem } from '@/lib/api';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  provider?: string;
  createdAt: string;
}

interface UseChatReturn {
  messages: ChatMessage[];
  isStreaming: boolean;
  conversationId: string | null;
  sendMessage: (text: string, agentName?: string) => void;
}

let msgCounter = 0;
function tempId(): string {
  msgCounter += 1;
  return `tmp-${msgCounter}-${Date.now()}`;
}

export function useChat(initialConversationId: string | null): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Load existing conversation messages on mount (when a conversationId is provided)
  useEffect(() => {
    if (!initialConversationId) return;
    let cancelled = false;

    getMessages(initialConversationId)
      .then((items: MessageItem[]) => {
        if (cancelled) return;
        const mapped: ChatMessage[] = items
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: m.content,
            provider: m.model,
            createdAt: m.createdAt,
          }));
        setMessages(mapped);
      })
      .catch(() => {
        // Silently fail — conversation may be new
      });

    return () => { cancelled = true; };
  }, [initialConversationId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
      }
    };
  }, []);

  const sendMessage = useCallback(
    (text: string, agentName?: string) => {
      if (isStreaming || !text.trim()) return;

      const userMsg: ChatMessage = {
        id: tempId(),
        role: 'user',
        content: text.trim(),
        createdAt: new Date().toISOString(),
      };

      const assistantId = tempId();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);

      const cleanup = streamChat(
        {
          message: text.trim(),
          conversationId: conversationId ?? undefined,
          agentName: agentName ?? undefined,
        },
        (chunk: string) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + chunk } : m,
            ),
          );
        },
        (convId: string, provider: string) => {
          if (convId) setConversationId(convId);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, provider } : m,
            ),
          );
          setIsStreaming(false);
        },
        (_err: Error) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: m.content || 'Error: failed to get response.' }
                : m,
            ),
          );
          setIsStreaming(false);
        },
      );

      cleanupRef.current = cleanup;
    },
    [isStreaming, conversationId],
  );

  return { messages, isStreaming, conversationId, sendMessage };
}
