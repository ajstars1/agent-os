'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { ArrowUp, Square, Paperclip, Sparkles } from 'lucide-react';
import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';

interface Props {
  onSend: (text: string) => void;
  onCancel: () => void;
  isStreaming: boolean;
  suggestions?: string[];
}

export function ChatInput({ onSend, onCancel, isStreaming, suggestions = [] }: Props) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (!taRef.current) return;
    taRef.current.style.height = 'auto';
    taRef.current.style.height = `${Math.min(taRef.current.scrollHeight, 200)}px`;
  }, [value]);

  // Cmd/Ctrl+K to focus
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        taRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const submit = (): void => {
    const trimmed = value.trim();
    if (!trimmed || isStreaming) return;
    onSend(trimmed);
    setValue('');
  };

  const canSend = value.trim().length > 0 && !isStreaming;

  return (
    <motion.div
      initial={{ y: 20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 200, damping: 26, delay: 0.15 }}
      className="px-3 pb-3 z-10"
    >
      {/* Suggestions row */}
      <AnimatePresence>
        {suggestions.length > 0 && !value && !isStreaming && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="flex items-center gap-2 mb-2 px-1 overflow-x-auto"
          >
            <Sparkles className="w-3 h-3 text-pink/80 flex-shrink-0" strokeWidth={2.5} />
            {suggestions.map((s, i) => (
              <motion.button
                key={s}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.05 }}
                whileHover={{ y: -2, scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => setValue(s)}
                className="px-3 py-1 rounded-full glass-soft text-[11px] font-medium text-2 hover:text-1 hover:border-pink/30 transition-colors flex-shrink-0 focus-ring"
              >
                {s}
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input shell */}
      <motion.div
        animate={{
          boxShadow: focused
            ? '0 0 0 2px rgba(255,107,157,0.5), 0 12px 40px rgba(11,5,24,0.20)'
            : '0 8px 32px rgba(31, 38, 135, 0.15)',
        }}
        transition={{ duration: 0.25 }}
        className={cn(
          'glass-strong rounded-3xl px-3 py-2.5 flex items-end gap-2 relative',
          focused && 'gradient-border',
        )}
      >
        {/* Attach button (placeholder) */}
        <motion.button
          whileHover={{ scale: 1.1, rotate: -10 }}
          whileTap={{ scale: 0.92 }}
          className="w-9 h-9 rounded-full grid place-items-center text-3 hover:text-1 hover:bg-white/5 transition-colors mb-0.5 focus-ring"
          aria-label="attach"
        >
          <Paperclip className="w-4 h-4" strokeWidth={2} />
        </motion.button>

        {/* Textarea */}
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="ask nova anything…  (⌘↵ to send  ·  ⇧↵ for newline)"
          rows={1}
          className="flex-1 bg-transparent border-none outline-none resize-none text-[15px] leading-relaxed text-1 placeholder:text-3 py-2 px-1 max-h-[200px]"
          style={{ minHeight: '24px' }}
        />

        {/* Send / Stop button */}
        <motion.button
          whileHover={canSend || isStreaming ? { scale: 1.06, y: -1 } : {}}
          whileTap={canSend || isStreaming ? { scale: 0.94 } : {}}
          onClick={isStreaming ? onCancel : submit}
          disabled={!canSend && !isStreaming}
          className={cn(
            'w-10 h-10 rounded-full grid place-items-center transition-all mb-0.5 focus-ring',
            isStreaming
              ? 'bg-gradient-to-br from-pink to-lilac text-white shadow-glow-pink'
              : canSend
              ? 'bg-gradient-to-br from-pink to-lilac text-white shadow-glow-pink hover:shadow-glow-lilac'
              : 'bg-white/5 text-3 cursor-not-allowed',
          )}
          aria-label={isStreaming ? 'stop' : 'send'}
        >
          {isStreaming ? (
            <Square className="w-3.5 h-3.5 fill-current" strokeWidth={0} />
          ) : (
            <ArrowUp className="w-4.5 h-4.5" strokeWidth={2.8} />
          )}
        </motion.button>
      </motion.div>

      {/* Hint */}
      <div className="flex items-center justify-between mt-1.5 px-3 text-[10px] text-4 font-medium">
        <span>local · private · all data on your machine</span>
        <span><kbd className="font-mono">⌘K</kbd> focus  ·  <kbd className="font-mono">⎋</kbd> stop</span>
      </div>
    </motion.div>
  );
}
