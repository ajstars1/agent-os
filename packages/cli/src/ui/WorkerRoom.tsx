/**
 * WorkerRoom — live "office floor" panel showing active AI workers.
 *
 * GenZ-friendly agent names: nova (main), zara, echo, flux, byte, pixel, rio, sol, ash, kai
 * Shows only when agents are active; hides 800ms after all are done.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { AgentUpdate, AgentStatus } from '@agent-os-core/shared';

// ─── Name registry ────────────────────────────────────────────────────────────

const WORKER_NAMES = ['zara', 'echo', 'flux', 'byte', 'pixel', 'rio', 'sol', 'ash', 'kai', 'lyra'];
const nameCache = new Map<string, string>();

export function resolveAgentName(agentId: string): string {
  if (agentId === 'main' || agentId === 'orchestrator') return 'nova';
  if (nameCache.has(agentId)) return nameCache.get(agentId)!;
  const idx = nameCache.size % WORKER_NAMES.length;
  const name = WORKER_NAMES[idx] ?? `w${idx}`;
  nameCache.set(agentId, name);
  return name;
}

// ─── Status visual config ─────────────────────────────────────────────────────

interface StatusStyle { icon: string; color: string }

const STATUS_STYLE: Record<AgentStatus, StatusStyle> = {
  thinking:  { icon: '✦', color: 'cyan'      },
  planning:  { icon: '◈', color: 'magenta'   },
  running:   { icon: '⚡', color: 'yellow'    },
  waiting:   { icon: '○', color: 'gray'      },
  done:      { icon: '✓', color: 'green'     },
  error:     { icon: '✗', color: 'red'       },
};

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function useSpinner(): string {
  const [f, setF] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setF((n) => (n + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return FRAMES[f] ?? '⠋';
}

// ─── Single worker row ────────────────────────────────────────────────────────

function WorkerRow({ worker }: { worker: AgentUpdate }): React.ReactElement {
  const name = resolveAgentName(worker.agentId);
  const isMain = worker.agentId === 'main' || worker.agentId === 'orchestrator';
  const style = STATUS_STYLE[worker.status];
  const elapsed = fmtMs(worker.elapsedMs);

  // Description shown next to name
  let desc = '';
  if (worker.status === 'running' && worker.tool) {
    desc = worker.toolPreview ? `${worker.tool} · ${worker.toolPreview}` : worker.tool;
  } else if (worker.note) {
    desc = worker.note;
  } else if (worker.task) {
    desc = worker.task;
  }

  // Truncate desc to avoid wrapping
  const maxDesc = 48;
  if (desc.length > maxDesc) desc = desc.slice(0, maxDesc - 1) + '…';

  return (
    <Box>
      <Text color={style.color}>{style.icon}</Text>
      <Text> </Text>
      <Text bold={isMain} color={isMain ? 'cyan' : 'white'}>{name.padEnd(6)}</Text>
      <Text dimColor>  </Text>
      <Text color={style.color === 'gray' ? undefined : style.color} dimColor={style.color === 'gray'}>
        {desc || worker.status}
      </Text>
      <Text dimColor>
        {worker.status !== 'done' && worker.status !== 'waiting'
          ? `  ${elapsed}`
          : ''}
      </Text>
    </Box>
  );
}

// ─── WorkerRoom panel ─────────────────────────────────────────────────────────

interface Props {
  workers: Map<string, AgentUpdate>;
  sessionCostUsd?: number;
}

export function WorkerRoom({ workers, sessionCostUsd }: Props): React.ReactElement | null {
  const spinner = useSpinner();

  const list = [...workers.values()].sort((a, b) => {
    // main agent first, then by agentId
    if (a.agentId === 'main') return -1;
    if (b.agentId === 'main') return 1;
    return a.agentId.localeCompare(b.agentId);
  });

  if (list.length === 0) return null;

  const active    = list.filter((w) => w.status === 'thinking' || w.status === 'running' || w.status === 'planning');
  const done      = list.filter((w) => w.status === 'done');
  const hasErrors = list.some((w) => w.status === 'error');

  // Iteration from main agent
  const mainWorker = workers.get('main') ?? list[0];
  const iter = mainWorker?.iteration ?? 0;
  const maxIter = mainWorker?.maxIterations ?? 40;

  // Footer meta
  const parts: string[] = [];
  if (active.length > 0) parts.push(`${active.length} active`);
  if (done.length > 0) parts.push(`${done.length} done`);
  if (hasErrors) parts.push('errors!');
  if (iter > 0) parts.push(`iter ${iter}/${maxIter}`);
  if (sessionCostUsd && sessionCostUsd > 0) {
    parts.push(`$${sessionCostUsd < 0.01 ? sessionCostUsd.toFixed(4) : sessionCostUsd.toFixed(3)}`);
  }

  const borderColor = hasErrors ? 'red' : active.length > 0 ? 'cyan' : 'green';

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={borderColor} paddingX={1} paddingY={0}>
      {/* Header */}
      <Box marginBottom={list.length > 0 ? 0 : 0}>
        <Text color={borderColor} bold>
          {active.length > 0 ? `${spinner} ` : '  '}
        </Text>
        <Text color={borderColor} bold>crew</Text>
        {parts.length > 0 && (
          <Text dimColor>{'  ·  '}{parts.join('  ·  ')}</Text>
        )}
      </Box>

      {/* Worker rows */}
      {list.map((w) => (
        <Box key={w.agentId} marginTop={0} paddingLeft={2}>
          <WorkerRow worker={w} />
        </Box>
      ))}
    </Box>
  );
}
