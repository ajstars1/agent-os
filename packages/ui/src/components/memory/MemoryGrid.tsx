'use client';

import { ChunkCard } from './ChunkCard';
import type { ChunkSummary, ChunkDetail } from '@/lib/api';

interface MemoryGridProps {
  chunks: ChunkSummary[];
  selectedChunk: ChunkDetail | null;
  onSelectChunk: (id: string) => void;
  onClearSelection: () => void;
}

const BrainIcon = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#4b5563]">
    <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
    <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
  </svg>
);

export function MemoryGrid({ chunks, selectedChunk, onSelectChunk, onClearSelection }: MemoryGridProps) {
  if (chunks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <BrainIcon />
        <div className="text-center">
          <p className="text-sm font-medium text-[#6b7280]">No memory chunks yet.</p>
          <p className="text-xs text-[#4b5563] mt-1">Start chatting to build memory.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {chunks.map((chunk) => (
          <ChunkCard
            key={chunk.id}
            chunk={chunk}
            detail={selectedChunk?.id === chunk.id ? selectedChunk : null}
            isLoadingDetail={false}
            isSelected={selectedChunk?.id === chunk.id}
            onSelect={onSelectChunk}
            onDeselect={onClearSelection}
          />
        ))}
      </div>
    </div>
  );
}
