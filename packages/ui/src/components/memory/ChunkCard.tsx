'use client';

import { useState } from 'react';
import type { ChunkSummary, ChunkDetail } from '@/lib/api';

interface ChunkCardProps {
  chunk: ChunkSummary;
  detail: ChunkDetail | null;
  isLoadingDetail: boolean;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDeselect: () => void;
}

type Tab = 'L1' | 'L2' | 'L3';

function formatTimestamp(ms: number): string {
  if (!ms) return 'Never';
  const date = new Date(ms);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

export function ChunkCard({ chunk, detail, isLoadingDetail, isSelected, onSelect, onDeselect }: ChunkCardProps) {
  const [activeTab, setActiveTab] = useState<Tab>('L1');

  const handleToggle = () => {
    if (isSelected) {
      onDeselect();
    } else {
      onSelect(chunk.id);
    }
  };

  const tabs: Tab[] = ['L1', 'L2', 'L3'];

  return (
    <div
      className={`rounded-xl border transition-all duration-200 overflow-hidden ${
        isSelected
          ? 'border-[#7c3aed]/50 bg-[#7c3aed]/5'
          : 'border-[#1f1f1f] bg-[#111111] hover:border-[#2d2d2d]'
      }`}
    >
      {/* Card header — always visible */}
      <button
        onClick={handleToggle}
        className="w-full text-left p-4 flex flex-col gap-2"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-[#f0f0f0] truncate">{chunk.topic}</h3>
            <p className="text-xs text-[#9ca3af] mt-1 line-clamp-2">{chunk.L0}</p>
          </div>
          <span className={`text-[#6b7280] flex-shrink-0 mt-0.5 ${isSelected ? 'text-[#a78bfa]' : ''}`}>
            <ChevronIcon expanded={isSelected} />
          </span>
        </div>

        {/* Tags */}
        {chunk.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {chunk.tags.slice(0, 4).map((tag) => (
              <span
                key={tag}
                className="px-2 py-0.5 rounded-full text-[10px] bg-[#1f1f1f] text-[#6b7280] border border-[#2d2d2d]"
              >
                {tag}
              </span>
            ))}
            {chunk.tags.length > 4 && (
              <span className="text-[10px] text-[#4b5563] py-0.5">+{chunk.tags.length - 4}</span>
            )}
          </div>
        )}

        {/* Stats */}
        <div className="flex items-center gap-3 text-[10px] text-[#4b5563]">
          <span>
            <span className="text-[#6b7280] font-medium">{chunk.accessCount}</span> accesses
          </span>
          <span>·</span>
          <span>Last: {formatTimestamp(chunk.lastAccessed)}</span>
        </div>
      </button>

      {/* Expanded detail */}
      {isSelected && (
        <div className="border-t border-[#1f1f1f] bg-[#0d0d0d]">
          {isLoadingDetail ? (
            <div className="flex items-center justify-center py-8">
              <div className="flex gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-[#7c3aed] animate-pulse-dot" />
                <div className="w-1.5 h-1.5 rounded-full bg-[#7c3aed] animate-pulse-dot" />
                <div className="w-1.5 h-1.5 rounded-full bg-[#7c3aed] animate-pulse-dot" />
              </div>
            </div>
          ) : detail ? (
            <div>
              {/* Tabs */}
              <div className="flex border-b border-[#1f1f1f]">
                {tabs.map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-4 py-2 text-xs font-medium transition-colors ${
                      activeTab === tab
                        ? 'text-[#a78bfa] border-b-2 border-[#7c3aed] -mb-px'
                        : 'text-[#6b7280] hover:text-[#f0f0f0]'
                    }`}
                  >
                    {tab}
                    <span className="ml-1.5 text-[10px] text-[#4b5563]">
                      {tab === 'L1' ? 'Summary' : tab === 'L2' ? 'Detail' : 'Full'}
                    </span>
                  </button>
                ))}
              </div>

              {/* Tab content */}
              <div className="p-4">
                <p className="text-xs text-[#d1d5db] leading-relaxed whitespace-pre-wrap font-mono">
                  {detail[activeTab]}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-[#6b7280] p-4 text-center">Failed to load detail.</p>
          )}
        </div>
      )}
    </div>
  );
}
