'use client';

import { motion } from 'framer-motion';
import { Sparkles, DollarSign, Settings2, Plus } from 'lucide-react';

interface Props {
  model: string;
  provider: string;
  sessionCostUsd?: number;
  onNewChat: () => void;
}

const PROVIDER_GLOW: Record<string, string> = {
  claude:     'shadow-glow-pink',
  gemini:     'shadow-glow-lilac',
  openrouter: 'shadow-glow-pink',
  ollama:     'shadow-glow-lilac',
};

export function Header({ model, provider, sessionCostUsd, onNewChat }: Props) {
  const providerLabel = model || provider || 'agent-os';
  return (
    <motion.header
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 220, damping: 24 }}
      className="glass-strong rounded-2xl mx-3 mt-3 px-4 py-2.5 flex items-center gap-3 z-30 relative"
    >
      {/* Logo */}
      <div className="flex items-center gap-2.5">
        <motion.div
          animate={{ rotate: [0, 360] }}
          transition={{ duration: 24, repeat: Infinity, ease: 'linear' }}
          className={`w-7 h-7 rounded-xl bg-gradient-to-br from-pink via-lilac to-sky ${PROVIDER_GLOW[provider] ?? 'shadow-glow-pink'} grid place-items-center`}
        >
          <Sparkles className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
        </motion.div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-bold tracking-tight text-1">
            agent<span className="gradient-text-arc">os</span>
          </span>
          <span className="text-[10px] uppercase tracking-[0.18em] text-3 font-medium">
            playful · glass
          </span>
        </div>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Model badge */}
      <div className="flex items-center gap-2 px-3 py-1 rounded-full glass">
        <span className="w-1.5 h-1.5 rounded-full bg-mint animate-pulse-soft" />
        <span className="text-xs font-mono text-2 tracking-tight">{providerLabel}</span>
      </div>

      {/* Cost */}
      {sessionCostUsd !== undefined && sessionCostUsd > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full glass">
          <DollarSign className="w-3 h-3 text-sun" strokeWidth={2.5} />
          <span className="text-xs font-mono text-2 tabular-nums">
            {sessionCostUsd < 0.01 ? sessionCostUsd.toFixed(4) : sessionCostUsd.toFixed(3)}
          </span>
        </div>
      )}

      {/* New chat button */}
      <motion.button
        whileHover={{ scale: 1.04, y: -1 }}
        whileTap={{ scale: 0.97 }}
        onClick={onNewChat}
        className="group flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gradient-to-r from-pink to-lilac text-white text-xs font-semibold shadow-glow-pink hover:shadow-glow-lilac transition-shadow"
      >
        <Plus className="w-3.5 h-3.5" strokeWidth={3} />
        new chat
      </motion.button>

      <motion.button
        whileHover={{ rotate: 90 }}
        transition={{ duration: 0.4 }}
        className="w-8 h-8 rounded-full glass grid place-items-center text-2 hover:text-1 focus-ring"
        aria-label="settings"
      >
        <Settings2 className="w-4 h-4" strokeWidth={2} />
      </motion.button>
    </motion.header>
  );
}
