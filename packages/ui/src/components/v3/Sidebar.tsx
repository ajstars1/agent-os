'use client';

import { motion } from 'framer-motion';
import { MessageSquare, Sparkles, Brain, Workflow, Mic, FileText } from 'lucide-react';
import { cn } from '@/lib/cn';

interface Props {
  active?: 'chat' | 'skills' | 'memory' | 'workflows' | 'voice';
}

const NAV = [
  { id: 'chat',      label: 'chats',     icon: MessageSquare, gradient: 'from-pink to-lilac' },
  { id: 'skills',    label: 'skills',    icon: Sparkles,      gradient: 'from-lilac to-sky' },
  { id: 'memory',    label: 'memory',    icon: Brain,         gradient: 'from-sky to-mint' },
  { id: 'workflows', label: 'workflows', icon: Workflow,      gradient: 'from-mint to-sun' },
  { id: 'voice',     label: 'voice',     icon: Mic,           gradient: 'from-sun to-pink' },
] as const;

const RECENT = [
  { title: 'review the agent-os codebase',     time: '2m'  },
  { title: 'build a todo app in react',        time: '14m' },
  { title: 'debug the failing test',           time: '1h'  },
  { title: 'refactor the engine',              time: '3h'  },
  { title: 'plan the next sprint',             time: 'yesterday' },
];

export function Sidebar({ active = 'chat' }: Props) {
  return (
    <motion.aside
      initial={{ x: -20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 200, damping: 26, delay: 0.05 }}
      className="glass rounded-2xl ml-3 my-3 w-64 flex flex-col p-2.5 z-20 relative overflow-hidden"
    >
      {/* Nav */}
      <nav className="flex flex-col gap-0.5 mb-4">
        {NAV.map(({ id, label, icon: Icon, gradient }) => {
          const isActive = id === active;
          return (
            <motion.button
              key={id}
              whileHover={{ x: 3 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              className={cn(
                'group flex items-center gap-2.5 px-3 py-2 rounded-xl text-left transition-colors focus-ring',
                isActive ? 'bg-white/10 text-1' : 'text-2 hover:bg-white/5 hover:text-1',
              )}
            >
              <span
                className={cn(
                  'w-7 h-7 rounded-lg grid place-items-center transition-all',
                  isActive
                    ? `bg-gradient-to-br ${gradient} shadow-glass-pink`
                    : 'bg-white/5 group-hover:bg-white/10',
                )}
              >
                <Icon className={cn('w-3.5 h-3.5', isActive ? 'text-white' : 'text-2')} strokeWidth={2} />
              </span>
              <span className="text-sm font-medium tracking-tight">{label}</span>
              {isActive && (
                <motion.span
                  layoutId="nav-pill"
                  className="ml-auto w-1.5 h-1.5 rounded-full bg-pink"
                />
              )}
            </motion.button>
          );
        })}
      </nav>

      {/* Recent chats */}
      <div className="px-3 mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.2em] text-3 font-semibold">recent</span>
        <FileText className="w-3 h-3 text-3" strokeWidth={2} />
      </div>

      <div className="flex flex-col gap-0.5 px-1 overflow-y-auto flex-1">
        {RECENT.map((item, i) => (
          <motion.button
            key={i}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.1 + i * 0.04 }}
            whileHover={{ x: 3, backgroundColor: 'rgba(255,255,255,0.06)' }}
            className="flex flex-col gap-0.5 px-3 py-2 rounded-lg text-left text-2 hover:text-1 transition-colors group focus-ring"
          >
            <span className="text-[13px] font-medium leading-tight truncate">{item.title}</span>
            <span className="text-[10px] text-3 group-hover:text-2 transition-colors">{item.time}</span>
          </motion.button>
        ))}
      </div>

      {/* Footer */}
      <div className="mt-2 mx-1 p-3 rounded-xl glass-soft flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-pink via-lilac to-sky shadow-glow-pink grid place-items-center text-white font-bold text-sm">
          A
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-1 truncate">Ayush</div>
          <div className="text-[10px] text-3 truncate">free · upgrade for cloud</div>
        </div>
      </div>
    </motion.aside>
  );
}
