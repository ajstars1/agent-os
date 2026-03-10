'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

interface ChatInputProps {
  onSend: (text: string, agentName?: string) => void;
  isDisabled: boolean;
}

const AGENT_OPTIONS = ['default'] as const;

const SendIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

export function ChatInput({ onSend, isDisabled }: ChatInputProps) {
  const [text, setText] = useState('');
  const [agentName, setAgentName] = useState<string>(AGENT_OPTIONS[0]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = 24;
    const maxLines = 6;
    const maxHeight = lineHeight * maxLines + 24; // 24 for padding
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [text, adjustHeight]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isDisabled) return;
    onSend(trimmed, agentName === 'default' ? undefined : agentName);
    setText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, isDisabled, onSend, agentName]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="border-t border-[#1f1f1f] p-4 bg-[#0a0a0a]">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-end gap-3 bg-[#111111] border border-[#2d2d2d] rounded-2xl px-4 py-3 focus-within:border-[#7c3aed]/50 transition-colors">
          {/* Agent selector */}
          <select
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            disabled={isDisabled}
            className="text-xs text-[#6b7280] bg-transparent border-none outline-none cursor-pointer hover:text-[#f0f0f0] transition-colors disabled:opacity-50 mb-0.5 flex-shrink-0"
            aria-label="Select agent"
          >
            {AGENT_OPTIONS.map((a) => (
              <option key={a} value={a} className="bg-[#111111]">
                {a}
              </option>
            ))}
          </select>

          {/* Divider */}
          <div className="w-px h-4 bg-[#2d2d2d] flex-shrink-0 mb-0.5" />

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isDisabled}
            placeholder={isDisabled ? 'Responding…' : 'Ask anything… (Enter to send, Shift+Enter for newline)'}
            rows={1}
            className="flex-1 bg-transparent text-sm text-[#f0f0f0] placeholder-[#4b5563] resize-none outline-none leading-6 disabled:opacity-50 max-h-36 overflow-y-auto"
            style={{ minHeight: '24px' }}
          />

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={isDisabled || !text.trim()}
            className="flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center bg-[#7c3aed] text-white hover:bg-[#6d28d9] disabled:opacity-30 disabled:cursor-not-allowed transition-all hover:scale-105 active:scale-95 mb-0.5"
            aria-label="Send message"
          >
            <SendIcon />
          </button>
        </div>
        <p className="text-[10px] text-[#4b5563] text-center mt-2">
          AgentOS may make mistakes. Verify important info.
        </p>
      </div>
    </div>
  );
}
