'use client';

import { MemoryGrid } from '@/components/memory/MemoryGrid';
import { useMemory } from '@/lib/hooks/useMemory';

export default function MemoryPage() {
  const { chunks, isLoading, error, selectedChunk, selectChunk, clearSelection } = useMemory();

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="border-b border-[#1f1f1f] px-6 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-sm font-medium text-[#f0f0f0]">HAM Memory</h1>
          <p className="text-xs text-[#6b7280] mt-0.5">
            Hierarchical Associative Memory — knowledge chunks
          </p>
        </div>
        {chunks.length > 0 && (
          <span className="text-xs text-[#6b7280] bg-[#1f1f1f] px-2 py-1 rounded">
            {chunks.length} chunk{chunks.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading && (
          <div className="flex items-center justify-center h-32">
            <div className="flex gap-1.5">
              <div className="w-2 h-2 rounded-full bg-[#7c3aed] animate-pulse-dot" />
              <div className="w-2 h-2 rounded-full bg-[#7c3aed] animate-pulse-dot" />
              <div className="w-2 h-2 rounded-full bg-[#7c3aed] animate-pulse-dot" />
            </div>
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center h-32">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}
        {!isLoading && !error && (
          <MemoryGrid
            chunks={chunks}
            selectedChunk={selectedChunk}
            onSelectChunk={selectChunk}
            onClearSelection={clearSelection}
          />
        )}
      </div>
    </div>
  );
}
