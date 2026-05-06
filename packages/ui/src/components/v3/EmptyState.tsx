'use client';

import { motion } from 'framer-motion';
import { Code2, FileText, Bug, Lightbulb, Database, Mic, Image as ImageIcon, Globe } from 'lucide-react';
import { cn } from '@/lib/cn';

const STARTERS = [
  { icon: Code2,      label: 'review the agent-os codebase',           gradient: 'from-pink to-lilac' },
  { icon: Bug,        label: 'debug a failing test',                   gradient: 'from-lilac to-sky' },
  { icon: Lightbulb,  label: 'brainstorm 20 product ideas',            gradient: 'from-sky to-mint' },
  { icon: FileText,   label: 'summarise this paper',                   gradient: 'from-mint to-sun' },
  { icon: Database,   label: 'analyse a CSV file',                     gradient: 'from-sun to-pink' },
  { icon: Globe,      label: 'browse and extract data',                gradient: 'from-pink to-sky' },
  { icon: ImageIcon,  label: 'generate an image',                      gradient: 'from-lilac to-pink' },
  { icon: Mic,        label: 'switch to voice mode',                   gradient: 'from-sky to-lilac' },
];

interface Props {
  onSend: (text: string) => void;
}

export function EmptyState({ onSend }: Props) {
  return (
    <div className="h-full flex flex-col items-center justify-center px-8 py-12">
      {/* Hero */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 200, damping: 26 }}
        className="text-center mb-8"
      >
        <motion.div
          animate={{ y: [0, -8, 0], rotate: [0, 5, -5, 0] }}
          transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
          className="w-20 h-20 mx-auto rounded-3xl bg-gradient-to-br from-pink via-lilac to-sky shadow-glow-pink mb-6 grid place-items-center relative"
        >
          <span className="text-3xl font-black text-white">N</span>
          <motion.div
            animate={{ scale: [1, 1.4, 1], opacity: [0.5, 0, 0.5] }}
            transition={{ duration: 2.4, repeat: Infinity }}
            className="absolute inset-0 rounded-3xl bg-gradient-to-br from-pink to-lilac"
          />
        </motion.div>

        <h1 className="text-4xl font-black tracking-tight mb-2">
          hey, i'm <span className="gradient-text-arc">nova</span>
        </h1>
        <p className="text-base text-2 max-w-md mx-auto">
          your personal ai crew. i think out loud,<br />
          delegate to specialists, and never lose context.
        </p>
      </motion.div>

      {/* Starters grid */}
      <motion.div
        initial="hidden"
        animate="visible"
        variants={{
          hidden:  {},
          visible: { transition: { staggerChildren: 0.04, delayChildren: 0.2 } },
        }}
        className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 max-w-3xl w-full"
      >
        {STARTERS.map(({ icon: Icon, label, gradient }, i) => (
          <motion.button
            key={i}
            variants={{
              hidden:  { opacity: 0, y: 12, scale: 0.96 },
              visible: { opacity: 1, y: 0,  scale: 1   },
            }}
            transition={{ type: 'spring', stiffness: 240, damping: 22 }}
            whileHover={{ y: -3, scale: 1.02 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => onSend(label)}
            className="group relative p-3 rounded-2xl glass-soft text-left overflow-hidden focus-ring"
          >
            <div className={cn('w-8 h-8 rounded-xl grid place-items-center bg-gradient-to-br mb-2.5 transition-transform group-hover:scale-110', gradient)}>
              <Icon className="w-4 h-4 text-white" strokeWidth={2.4} />
            </div>
            <p className="text-[12.5px] font-medium leading-snug text-1">{label}</p>
            {/* hover gradient hint */}
            <div className={cn('absolute inset-0 opacity-0 group-hover:opacity-10 bg-gradient-to-br pointer-events-none transition-opacity', gradient)} />
          </motion.button>
        ))}
      </motion.div>
    </div>
  );
}
