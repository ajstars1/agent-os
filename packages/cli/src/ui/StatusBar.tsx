/**
 * StatusBar v2 — minimal bottom bar. WorkerRoom handles live agent state.
 * Shows: cwd when idle · model + spinner when active · skill hints · planning banner.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { homedir } from 'node:os';

interface Props {
  status: 'idle' | 'thinking' | 'streaming';
  provider: string;
  resolvedModel?: string;
  inputTokens: number;
  outputTokens: number;
  finalElapsedMs: number;
  activeStartMs: number;
  cwd: string;
  skillSuggestions?: string[];
  isPlanning?: boolean;
  lastTurnCost?: number;
  sessionCost?: number;
  activeSubagents?: number;
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function useSpinner(active: boolean): string {
  const [f, setF] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setF((n) => (n + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, [active]);
  return active ? (FRAMES[f] ?? '⠋') : '';
}

function useLiveElapsed(startMs: number): string {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (!startMs) { setMs(0); return; }
    const tick = (): void => setMs(Date.now() - startMs);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startMs]);
  if (!ms) return '';
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function providerColor(p: string): string {
  if (p === 'gemini')     return 'green';
  if (p === 'openrouter') return 'yellow';
  if (p === 'ollama')     return 'magenta';
  return 'blueBright';
}

function fmtCost(usd: number): string {
  if (usd < 0.001) return `$${(usd * 1000).toFixed(2)}m`;
  return `$${usd.toFixed(3)}`;
}

// ─── StatusBar ────────────────────────────────────────────────────────────────

export function StatusBar({
  status,
  provider,
  resolvedModel,
  inputTokens,
  outputTokens,
  finalElapsedMs,
  activeStartMs,
  cwd,
  skillSuggestions = [],
  isPlanning = false,
  lastTurnCost,
  sessionCost,
}: Props): React.ReactElement {
  const isActive = status !== 'idle';
  const spinner  = useSpinner(isActive);
  const elapsed  = useLiveElapsed(isActive ? activeStartMs : 0);
  const cwdShort = cwd.replace(homedir(), '~');
  const color    = providerColor(provider);
  const model    = resolvedModel ?? provider;

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Planning banner */}
      {isPlanning && (
        <Box paddingX={2} marginBottom={1} borderStyle="bold" borderColor="yellow">
          <Text bold color="yellow"> plan mode  </Text>
          <Text dimColor>type </Text>
          <Text color="green" bold>approve</Text>
          <Text dimColor> or </Text>
          <Text color="red" bold>reject</Text>
        </Box>
      )}

      {/* Main bar */}
      <Box paddingX={1}>
        {isActive ? (
          /* Active — spinner + model + elapsed */
          <Box>
            <Text color={color}>{spinner} </Text>
            <Text color={color} bold>{model}</Text>
            <Text dimColor>
              {'  ·  '}
              {status === 'streaming' ? 'responding' : 'thinking'}
              {elapsed ? `  ${elapsed}` : ''}
            </Text>
          </Box>
        ) : (
          /* Idle — cwd + last turn stats */
          <Box flexWrap="wrap">
            <Text dimColor>{cwdShort}</Text>
            {(inputTokens > 0 || outputTokens > 0) && (
              <Text dimColor>
                {'  ·  '}
                {inputTokens.toLocaleString()}↑ {outputTokens.toLocaleString()}↓
                {'  '}
                {(finalElapsedMs / 1000).toFixed(1)}s
                {lastTurnCost && lastTurnCost > 0 ? `  ${fmtCost(lastTurnCost)}` : ''}
                {sessionCost && sessionCost > 0 ? `  [${fmtCost(sessionCost)} session]` : ''}
              </Text>
            )}
          </Box>
        )}
      </Box>

      {/* Skill hints — idle only */}
      {!isActive && skillSuggestions.length > 0 && (
        <Box paddingX={1} marginTop={0}>
          <Text dimColor>{'  💡 '}{skillSuggestions.join('  ')}</Text>
        </Box>
      )}
    </Box>
  );
}
