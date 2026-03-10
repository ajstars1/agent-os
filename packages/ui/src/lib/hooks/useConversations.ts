'use client';

import { useState, useEffect, useCallback } from 'react';
import { listConversations, deleteConversation } from '@/lib/api';
import type { ConversationSummary } from '@/lib/api';

interface UseConversationsReturn {
  conversations: ConversationSummary[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
  remove: (id: string) => Promise<void>;
}

export function useConversations(): UseConversationsReturn {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchConversations = useCallback(() => {
    setIsLoading(true);
    setError(null);

    listConversations()
      .then((data) => {
        setConversations(data);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setIsLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const remove = useCallback(async (id: string) => {
    await deleteConversation(id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
  }, []);

  return {
    conversations,
    isLoading,
    error,
    refetch: fetchConversations,
    remove,
  };
}
