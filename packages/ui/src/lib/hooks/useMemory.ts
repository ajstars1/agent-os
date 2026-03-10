'use client';

import { useState, useEffect, useCallback } from 'react';
import { listChunks, getChunk } from '@/lib/api';
import type { ChunkSummary, ChunkDetail } from '@/lib/api';

interface UseMemoryReturn {
  chunks: ChunkSummary[];
  isLoading: boolean;
  error: string | null;
  selectedChunk: ChunkDetail | null;
  isLoadingChunk: boolean;
  selectChunk: (id: string) => void;
  clearSelection: () => void;
  refetch: () => void;
}

export function useMemory(): UseMemoryReturn {
  const [chunks, setChunks] = useState<ChunkSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedChunk, setSelectedChunk] = useState<ChunkDetail | null>(null);
  const [isLoadingChunk, setIsLoadingChunk] = useState(false);

  const fetchChunks = useCallback(() => {
    setIsLoading(true);
    setError(null);

    listChunks()
      .then((data) => {
        setChunks(data);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setIsLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchChunks();
  }, [fetchChunks]);

  const selectChunk = useCallback((id: string) => {
    setIsLoadingChunk(true);

    getChunk(id)
      .then((detail) => {
        setSelectedChunk(detail);
        setIsLoadingChunk(false);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setIsLoadingChunk(false);
      });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedChunk(null);
  }, []);

  return {
    chunks,
    isLoading,
    error,
    selectedChunk,
    isLoadingChunk,
    selectChunk,
    clearSelection,
    refetch: fetchChunks,
  };
}
