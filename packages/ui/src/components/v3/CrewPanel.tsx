'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, Zap, CheckCircle2, AlertCircle, Clock, Brain, Wrench } from 'lucide-react';
import type { AgentUpdate, AgentStatus } from '@/lib/types';
import { cn } from '@/lib/cn';
import { useEffect, useState } from 'react';

// ─── Name registry ────────────────────────────────────────────────────────────

const WORKER_NAMES = ['zara', 'echo', 'flux', 'byte', 'pixel', 'rio', 'sol', 'ash', 'kai', 'lyra'];
const nameCache = new Map<string, string>();

function resolveName(agentId: string): string {
  if (agentId === 'main' || agentId === 'nova' || agentId === 'orchestrator') return 'nova';
  if (nameCache.has(agentId)) return nameCache.get(agentId)!;
  const idx = nameCache.size % WORKER_NAMES.length;
  const name = WORKER_NAMES[idx] ?? `w${idx}`;
  nameCache.set(agentId, name);
  return name;
}

// ─── Status visuals ───────────────────────────────────────────────────────────

const STATUS: Record<AgentStatus, { icon: typeof Sparkles; color: string; bg: string; label: string }> = {
  thinking: { icon: Brain,         color: 'text-lilac', bg: 'from-lilac to-sky',     label: 'thinking' },
  planning: { icon: Sparkles,      color: 'text-pink',  bg: 'from-pink to-lilac',    label: 'planning' },
  running:  { icon: Zap,           color: 'text-sun',   bg: 'from-sun to-pink',      label: 'running'  },
  waiting:  { icon: Clock,         color: 'text-3',     bg: 'from-white/10 to-white/5', label: 'waiting' },
  done:     { icon: CheckCircle2,  color: 'text-mint',  bg: 'from-mint to-sky',      label: 'done'     },
  error:    { icon: AlertCircle,   color: 'text-pink',  bg: 'from-pink to-lilac',    label: 'error'    },
};

// ─── Worker Card ──────────────────────────────────────────────────────────────

function WorkerCard({ worker }: { worker: AgentUpdate }) {
  const name = resolveName(worker.agentId);
  const isMain = name === 'nova';
  const style = STATUS[worker.status];
  const Icon = style.icon;
  const [elapsed, setElapsed] = useState(worker.elapsedMs);

  // Live tick for elapsed time while running/thinking
  useEffect(() => {
    if (worker.status === 'done' || worker.status === 'error' || worker.status === 'waiting') {
      setElapsed(worker.elapsedMs);
      return;
    }
    const start = Date.now() - worker.elapsedMs;
    const id = setInterval(() => setElapsed(Date.now() - start), 100);
    return () => clearInterval(id);
  }, [worker.elapsedMs, worker.status]);

  const elapsedStr = elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
  const progress   = worker.maxIterations > 0 ? worker.iteration / worker.maxIterations : 0;

  // What to show in the description line
  let description = '';
  if (worker.status === 'running' && worker.tool) {
    description = worker.tool;
  } else if (worker.note) {
    description = worker.note;
  } else if (worker.task) {
    description = worker.task;
  } else {
    description = style.label;
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.94, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{    opacity: 0, scale: 0.94, y: -8 }}
      transition={{ type: 'spring', stiffness: 260, damping: 24 }}
      className={cn(
        'relative p-3 rounded-2xl glass-soft overflow-hidden group',
        isMain && 'ring-1 ring-pink/30',
      )}
    >
      {/* Top row: icon + name + status + elapsed */}
      <div className="flex items-center gap-2.5 mb-2">
        <motion.div
          animate={worker.status === 'running' ? { rotate: 360 } : {}}
          transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
          className={cn(
            'w-8 h-8 rounded-xl grid place-items-center bg-gradient-to-br shadow-glass',
            style.bg,
          )}
        >
          <Icon className="w-4 h-4 text-white" strokeWidth={2.5} />
        </motion.div>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className={cn('text-sm font-bold', isMain ? 'gradient-text-arc' : 'text-1')}>
              {name}
            </span>
            <span className={cn('text-[10px] uppercase tracking-wider font-semibold', style.color)}>
              {style.label}
            </span>
          </div>
          {worker.status !== 'done' && worker.status !== 'waiting' && (
            <span className="text-[11px] text-3 font-mono tabular-nums">{elapsedStr}</span>
          )}
        </div>
      </div>

      {/* Description / current activity */}
      {description && description !== style.label && (
        <div className="mb-2 ml-0.5">
          {worker.status === 'running' && worker.tool ? (
            <div className="flex items-center gap-1.5 text-[12px]">
              <Wrench className="w-2.5 h-2.5 text-2" strokeWidth={2.5} />
              <span className="font-mono font-semibold text-2">{worker.tool}</span>
              {worker.toolPreview && (
                <span className="font-mono text-3 truncate">· {worker.toolPreview}</span>
              )}
            </div>
          ) : (
            <p className="text-[12px] text-2 truncate">{description}</p>
          )}
        </div>
      )}

      {/* Iteration progress bar */}
      {worker.maxIterations > 0 && worker.status !== 'done' && (
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1 rounded-full bg-white/5 overflow-hidden">
            <motion.div
              animate={{ width: `${Math.min(progress * 100, 100)}%` }}
              transition={{ type: 'spring', stiffness: 100, damping: 20 }}
              className={cn('h-full rounded-full bg-gradient-to-r', style.bg)}
            />
          </div>
          <span className="text-[10px] text-3 font-mono tabular-nums whitespace-nowrap">
            {worker.iteration}/{worker.maxIterations}
          </span>
        </div>
      )}

      {/* Shimmer on running */}
      {worker.status === 'running' && (
        <motion.div
          animate={{ x: ['-100%', '100%'] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
          className="absolute inset-0 pointer-events-none shimmer-bg opacity-30"
        />
      )}
    </motion.div>
  );
}

// ─── Crew Panel ───────────────────────────────────────────────────────────────

interface Props {
  workers: Map<string, AgentUpdate>;
  isStreaming: boolean;
  sessionTokens?: { input: number; output: number };
}

export function CrewPanel({ workers, isStreaming, sessionTokens }: Props) {
  const list = [...workers.values()].sort((a, b) => {
    if (a.agentId === 'nova' || a.agentId === 'main') return -1;
    if (b.agentId === 'nova' || b.agentId === 'main') return 1;
    return a.agentId.localeCompare(b.agentId);
  });

  const activeCount = list.filter((w) => w.status === 'thinking' || w.status === 'running' || w.status === 'planning').length;
  const doneCount   = list.filter((w) => w.status === 'done').length;
  const isIdle = list.length === 0;

  return (
    <motion.aside
      initial={{ x: 20, opacity: 0 }}
      animate={{ x: 0,  opacity: 1 }}
      transition={{ type: 'spring', stiffness: 200, damping: 26, delay: 0.1 }}
      className="glass rounded-2xl mr-3 my-3 w-72 flex flex-col z-20 relative overflow-hidden"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-pink to-lilac shadow-glow-pink grid place-items-center">
          <Sparkles className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
        </div>
        <div className="flex-1">
          <div className="text-sm font-bold tracking-tight">crew</div>
          <div className="text-[10px] text-3 font-medium">
            {isIdle ? 'idle · ready' : `${activeCount} active · ${doneCount} done`}
          </div>
        </div>
        {isStreaming && (
          <motion.div
            animate={{ scale: [1, 1.2, 1] }}
            transition={{ duration: 1.4, repeat: Infinity }}
            className="w-2 h-2 rounded-full bg-mint shadow-glow-lilac"
          />
        )}
      </div>

      {/* Worker list */}
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        <AnimatePresence mode="popLayout">
          {isIdle ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center text-center py-12 px-4"
            >
              <motion.div
                animate={{ y: [0, -8, 0] }}
                transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
                className="w-16 h-16 rounded-3xl bg-gradient-to-br from-pink/40 via-lilac/40 to-sky/40 grid place-items-center mb-3 shadow-glow-pink"
              >
                <Sparkles className="w-7 h-7 text-white/90" strokeWidth={2} />
              </motion.div>
              <p className="text-[13px] font-semibold text-2 mb-1">no crew yet</p>
              <p className="text-[11px] text-3 leading-relaxed">
                workers will appear here as nova<br />delegates parts of your task
              </p>
            </motion.div>
          ) : (
            list.map((w) => <WorkerCard key={w.agentId} worker={w} />)
          )}
        </AnimatePresence>
      </div>

      {/* Footer stats */}
      {sessionTokens && (sessionTokens.input > 0 || sessionTokens.output > 0) && (
        <div className="px-4 py-2.5 border-t border-white/5 flex items-center justify-between text-[11px] font-mono">
          <span className="text-3">tokens</span>
          <span className="flex items-center gap-2 text-2 tabular-nums">
            <span>↑ {sessionTokens.input.toLocaleString()}</span>
            <span className="text-3">·</span>
            <span>↓ {sessionTokens.output.toLocaleString()}</span>
          </span>
        </div>
      )}
    </motion.aside>
  );
}
