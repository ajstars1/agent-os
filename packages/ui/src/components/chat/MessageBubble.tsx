'use client';

import { useState } from 'react';
import type { ChatMessage } from '@/lib/hooks/useChat';

interface MessageBubbleProps {
  message: ChatMessage;
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ProviderBadge({ provider }: { provider?: string }) {
  if (!provider) return null;
  const isGemini = provider.toLowerCase().includes('gemini');
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
        isGemini
          ? 'bg-green-500/15 text-green-400 border border-green-500/20'
          : 'bg-blue-500/15 text-blue-400 border border-blue-500/20'
      }`}
    >
      {isGemini ? 'Gemini' : 'Claude'}
    </span>
  );
}

function renderContent(content: string): React.ReactNode {
  // Split by code blocks first
  const parts = content.split(/(```[\s\S]*?```|`[^`]+`)/g);

  return parts.map((part, i) => {
    if (part.startsWith('```')) {
      const match = /^```(\w*)\n?([\s\S]*?)```$/.exec(part);
      const code = match ? match[2] : part.slice(3, -3);
      const lang = match ? match[1] : '';
      return (
        <div key={i} className="my-2 rounded-md overflow-hidden border border-[#2d2d2d]">
          {lang && (
            <div className="px-3 py-1 bg-[#1a1a1a] border-b border-[#2d2d2d] text-[10px] text-[#6b7280] font-mono">
              {lang}
            </div>
          )}
          <pre className="p-3 bg-[#0f0f0f] overflow-x-auto text-xs font-mono text-[#e2e8f0] leading-relaxed">
            <code>{code.trim()}</code>
          </pre>
        </div>
      );
    }

    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} className="px-1.5 py-0.5 rounded bg-[#1f1f1f] font-mono text-xs text-[#e2e8f0] border border-[#2d2d2d]">
          {part.slice(1, -1)}
        </code>
      );
    }

    // Process bold and line breaks
    const lines = part.split('\n');
    return (
      <span key={i}>
        {lines.map((line, li) => {
          const boldParts = line.split(/(\*\*[^*]+\*\*)/g);
          return (
            <span key={li}>
              {boldParts.map((bp, bi) => {
                if (bp.startsWith('**') && bp.endsWith('**')) {
                  return <strong key={bi} className="font-semibold">{bp.slice(2, -2)}</strong>;
                }
                return <span key={bi}>{bp}</span>;
              })}
              {li < lines.length - 1 && <br />}
            </span>
          );
        })}
      </span>
    );
  });
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const [showTime, setShowTime] = useState(false);
  const isUser = message.role === 'user';

  return (
    <div
      className={`flex ${isUser ? 'justify-end' : 'justify-start'} group mb-4`}
      onMouseEnter={() => setShowTime(true)}
      onMouseLeave={() => setShowTime(false)}
    >
      <div className={`max-w-[75%] flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
        {/* Provider badge for assistant */}
        {!isUser && (
          <div className="flex items-center gap-2 px-1">
            <ProviderBadge provider={message.provider} />
          </div>
        )}

        {/* Bubble */}
        <div
          className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
            isUser
              ? 'bg-[#7c3aed] text-white rounded-tr-md'
              : 'bg-[#1a1a1a] text-[#f0f0f0] border border-[#2d2d2d] rounded-tl-md'
          }`}
        >
          {renderContent(message.content)}
        </div>

        {/* Timestamp */}
        <div
          className={`text-[10px] text-[#4b5563] px-1 transition-opacity duration-150 ${
            showTime ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {formatTime(message.createdAt)}
        </div>
      </div>
    </div>
  );
}
