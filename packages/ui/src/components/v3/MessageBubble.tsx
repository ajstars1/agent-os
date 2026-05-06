'use client';

import { motion } from 'framer-motion';
import { Sparkles, CheckCircle2, XCircle, Wrench } from 'lucide-react';
import type { ChatMessage, ToolCallRecord } from '@/lib/types';
import { Markdown } from './Markdown';
import { cn } from '@/lib/cn';

interface Props { message: ChatMessage }

const PROVIDER_GRADIENT: Record<string, string> = {
  claude:     'from-pink to-lilac',
  gemini:     'from-mint to-sky',
  openrouter: 'from-sun to-pink',
  ollama:     'from-lilac to-sky',
};

const PROVIDER_GLOW: Record<string, string> = {
  claude:     'shadow-glow-pink',
  gemini:     'shadow-glow-lilac',
  openrouter: 'shadow-glow-pink',
  ollama:     'shadow-glow-lilac',
};

export function MessageBubble({ message }: Props) {
  if (message.role === 'user') {
    return (
      <motion.div
        initial={{ y: 12, opacity: 0, scale: 0.98 }}
        animate={{ y: 0,  opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 240, damping: 24 }}
        className="flex justify-end mb-4"
      >
        <div className="max-w-[78%] px-4 py-3 rounded-2xl rounded-br-md bg-gradient-to-br from-pink/90 to-lilac/85 text-white shadow-glow-pink">
          <p className="text-[15px] leading-relaxed font-medium whitespace-pre-wrap">{message.content}</p>
        </div>
      </motion.div>
    );
  }

  const provider = message.provider ?? 'claude';
  const gradient = PROVIDER_GRADIENT[provider] ?? 'from-pink to-lilac';
  const glow     = PROVIDER_GLOW[provider]     ?? 'shadow-glow-pink';

  return (
    <motion.div
      initial={{ y: 12, opacity: 0 }}
      animate={{ y: 0,  opacity: 1 }}
      transition={{ type: 'spring', stiffness: 220, damping: 26 }}
      className="mb-4"
    >
      {/* Provider header */}
      <div className="flex items-center gap-2 mb-2 ml-1">
        <div className={cn('w-6 h-6 rounded-lg grid place-items-center bg-gradient-to-br', gradient, glow)}>
          <Sparkles className="w-3 h-3 text-white" strokeWidth={2.5} />
        </div>
        <span className="text-[13px] font-semibold gradient-text-arc">{message.model || provider}</span>
        {message.elapsedMs && (
          <span className="text-[11px] text-3 font-mono tabular-nums">
            {(message.elapsedMs / 1000).toFixed(1)}s
          </span>
        )}
      </div>

      {/* Content card */}
      <div className="glass rounded-2xl rounded-tl-md px-5 py-4 max-w-[88%]">
        <Markdown content={message.content} />
      </div>

      {/* Tool calls executed during this message */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="mt-2 ml-1 flex flex-col gap-1.5">
          {message.toolCalls.map((tc) => <ToolCallRow key={tc.id} tool={tc} />)}
        </div>
      )}
    </motion.div>
  );
}

// ─── Tool call compact row ────────────────────────────────────────────────────

function ToolCallRow({ tool }: { tool: ToolCallRecord }) {
  const elapsed = tool.elapsedMs ?? 0;
  const elapsedStr = elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;

  return (
    <motion.div
      initial={{ x: -8, opacity: 0 }}
      animate={{ x: 0,  opacity: 1 }}
      transition={{ type: 'spring', stiffness: 260, damping: 22 }}
      className="flex items-center gap-2 px-3 py-1.5 rounded-xl glass-soft text-[12.5px]"
    >
      <Wrench className="w-3 h-3 text-2 flex-shrink-0" strokeWidth={2.4} />
      <span className="font-mono font-semibold text-2">{tool.name}</span>
      {tool.preview && (
        <span className="font-mono text-3 truncate">{tool.preview}</span>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        <span className="text-3 font-mono tabular-nums text-[11px]">{elapsedStr}</span>
        {tool.isError ? (
          <XCircle    className="w-3.5 h-3.5 text-pink"  strokeWidth={2.5} />
        ) : (
          <CheckCircle2 className="w-3.5 h-3.5 text-mint" strokeWidth={2.5} />
        )}
      </span>
    </motion.div>
  );
}
