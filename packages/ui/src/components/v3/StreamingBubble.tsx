'use client';

import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { Markdown } from './Markdown';
import { cn } from '@/lib/cn';

interface Props {
  content: string;
  provider: string;
  model: string;
}

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

export function StreamingBubble({ content, provider, model }: Props) {
  const gradient = PROVIDER_GRADIENT[provider] ?? 'from-pink to-lilac';
  const glow     = PROVIDER_GLOW[provider]     ?? 'shadow-glow-pink';

  return (
    <motion.div
      initial={{ y: 10, opacity: 0 }}
      animate={{ y: 0,  opacity: 1 }}
      transition={{ type: 'spring', stiffness: 220, damping: 24 }}
      className="mb-4"
    >
      {/* Provider header — shimmer animated bg while streaming */}
      <div className="flex items-center gap-2 mb-2 ml-1">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
          className={cn('w-6 h-6 rounded-lg grid place-items-center bg-gradient-to-br', gradient, glow)}
        >
          <Sparkles className="w-3 h-3 text-white" strokeWidth={2.5} />
        </motion.div>
        <span className="text-[13px] font-semibold gradient-text-arc">{model || provider}</span>
        <span className="text-[11px] text-3 font-medium animate-pulse-soft">writing…</span>
      </div>

      {/* Streaming card */}
      <div className="glass rounded-2xl rounded-tl-md px-5 py-4 max-w-[88%] gradient-border">
        <div className="typing-cursor inline">
          <Markdown content={content} />
        </div>
      </div>
    </motion.div>
  );
}
