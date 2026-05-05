import React from 'react';
import { Box, Text } from 'ink';
import { homedir } from 'node:os';
import { formatCost } from '@agent-os-core/shared';

interface Props {
  status: 'idle' | 'thinking' | 'streaming';
  provider: string;
  resolvedModel?: string;
  inputTokens: number;
  outputTokens: number;
  finalElapsedMs: number;
  activeStartMs: number;           // non-zero when a request is in-flight
  cwd: string;
  skillSuggestions?: string[];
  isPlanning?: boolean;
  /** USD cost for the last turn. */
  lastTurnCost?: number;
  /** Cumulative USD cost for the session. */
  sessionCost?: number;
  /** Number of active subagents (0 = none). */
  activeSubagents?: number;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function useSpinner(active: boolean): string {
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [active]);
  return active ? (SPINNER_FRAMES[frame] ?? '⠋') : '';
}

/** Ticks every second while active, returns human-readable elapsed like "3s" or "1m 12s". */
function useLiveElapsed(activeStartMs: number): string {
  const [ms, setMs] = React.useState(0);
  React.useEffect(() => {
    if (!activeStartMs) { setMs(0); return; }
    const tick = (): void => setMs(Date.now() - activeStartMs);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [activeStartMs]);

  if (!ms) return '';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

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
  activeSubagents = 0,
}: Props): React.ReactElement {
  const isActive = status !== 'idle';
  const spinnerFrame = useSpinner(isActive);
  const liveElapsed = useLiveElapsed(isActive ? activeStartMs : 0);
  const cwdShort = cwd.replace(homedir(), '~');
  const finalSec = (finalElapsedMs / 1000).toFixed(1);
  const hasTokens = inputTokens > 0 || outputTokens > 0;
  const providerColor = provider === 'gemini' ? 'green' : 'blue';
  const modelLabel = resolvedModel ?? provider;
  const statusLabel = status === 'thinking' ? 'thinking…' : 'responding…';

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        borderStyle="round"
        borderColor="dim"
        paddingX={1}
      >
        {isActive ? (
          <Box>
            <Text color="yellow">{spinnerFrame} </Text>
            <Text color={providerColor} bold>{modelLabel}</Text>
            <Text dimColor>{'  '}{statusLabel}</Text>
            {liveElapsed ? <Text dimColor>{'  · '}{liveElapsed}</Text> : null}
          </Box>
        ) : (
          <Box>
            <Text dimColor>{cwdShort}</Text>
            {hasTokens && (
              <Text dimColor>
                {'  '}{inputTokens.toLocaleString()}{'↑ '}{outputTokens.toLocaleString()}{'↓  '}{finalSec}{'s'}
                {lastTurnCost !== undefined && lastTurnCost > 0 ? (
                  <Text dimColor>{'  ~'}{formatCost(lastTurnCost)}</Text>
                ) : null}
                {sessionCost !== undefined && sessionCost > 0 ? (
                  <Text dimColor>{'  ['}{formatCost(sessionCost)}{' total]'}</Text>
                ) : null}
              </Text>
            )}
            {activeSubagents > 0 && (
              <Text color="cyan" dimColor>
                {'  ⚡'}{activeSubagents}{' agent'}{activeSubagents !== 1 ? 's' : ''}
              </Text>
            )}
            {skillSuggestions.length > 0 && (
              <Text dimColor>
                {'  💡 '}
                {skillSuggestions.join('  ')}
              </Text>
            )}
          </Box>
        )}
      </Box>
      {isPlanning && (
        <Box paddingX={1} marginTop={1} borderStyle="bold" borderColor="yellow">
          <Text color="yellow" bold inverse> PLANNING MODE </Text>
          <Text color="yellow">  Review the proposed plan and type </Text>
          <Text color="green" bold>"Approve"</Text>
          <Text color="yellow"> to proceed or </Text>
          <Text color="red" bold>"Reject"</Text>
          <Text color="yellow"> to cancel.</Text>
        </Box>
      )}
    </Box>
  );
}
