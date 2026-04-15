import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Key } from 'ink';

const BASE_COMMANDS = [
  'help', 'clear', 'model', 'config', 'cd', 'cwd', 'dream',
  'agents', 'skills', 'memory', 'export', 'exit',
];

interface InputState {
  buffer: string;
  cursor: number;
}

interface Props {
  onSubmit: (value: string) => void;
  isDisabled: boolean;
  commands: string[];
  history: string[];
}

function getMatchingCommands(input: string, allCommands: string[]): string[] {
  if (!input.startsWith('/')) return [];
  const prefix = input.slice(1).toLowerCase();
  return allCommands.filter((c) => c.toLowerCase().startsWith(prefix));
}

export function PromptInput({ onSubmit, isDisabled, commands, history }: Props): React.ReactElement {
  // Single atomic state — eliminates all stale-closure bugs
  const [{ buffer, cursor }, setInput] = useState<InputState>({ buffer: '', cursor: 0 });
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [showPopup, setShowPopup] = useState(false);

  // Keep historyIndex stable across renders with a ref for use in callbacks
  const historyIndexRef = useRef(historyIndex);
  historyIndexRef.current = historyIndex;

  const allCommands = [...new Set([...BASE_COMMANDS, ...commands])];

  useEffect(() => {
    if (buffer.startsWith('/')) {
      const matches = getMatchingCommands(buffer, allCommands);
      setSuggestions(matches.slice(0, 6));
      setShowPopup(matches.length > 0 && buffer.length > 1);
      setSelectedSuggestion(0);
    } else {
      setShowPopup(false);
      setSuggestions([]);
    }
  }, [buffer]); // eslint-disable-line react-hooks/exhaustive-deps

  const reset = useCallback((newBuffer = '', newCursor = 0): void => {
    setInput({ buffer: newBuffer, cursor: newCursor });
    setHistoryIndex(-1);
    setShowPopup(false);
  }, []);

  const handleSubmit = useCallback((): void => {
    if (!buffer.trim()) return;
    const val = buffer.trim();
    reset();
    onSubmit(val);
  }, [buffer, onSubmit, reset]);

  useInput((input: string, key: Key) => {
    if (isDisabled) return;

    // ── Enter ──────────────────────────────────────────────────────────────
    if (key.return) {
      if (showPopup && suggestions.length > 0) {
        const chosen = suggestions[selectedSuggestion];
        if (chosen !== undefined) {
          reset();
          onSubmit('/' + chosen);
          return;
        }
      }
      handleSubmit();
      return;
    }

    // ── Tab: cycle suggestions ─────────────────────────────────────────────
    if (key.tab) {
      if (showPopup && suggestions.length > 0) {
        const next = (selectedSuggestion + 1) % suggestions.length;
        setSelectedSuggestion(next);
        const chosen = suggestions[next];
        if (chosen !== undefined) {
          const completed = '/' + chosen;
          setInput({ buffer: completed, cursor: completed.length });
        }
      }
      return;
    }

    // ── Escape: close popup ────────────────────────────────────────────────
    if (key.escape) {
      setShowPopup(false);
      return;
    }

    // ── Up arrow ───────────────────────────────────────────────────────────
    if (key.upArrow) {
      if (showPopup) {
        setSelectedSuggestion((s) => Math.max(0, s - 1));
        return;
      }
      const nextIdx = Math.min(historyIndexRef.current + 1, history.length - 1);
      setHistoryIndex(nextIdx);
      const entry = history[history.length - 1 - nextIdx];
      if (entry !== undefined) {
        setInput({ buffer: entry, cursor: entry.length });
      }
      return;
    }

    // ── Down arrow ─────────────────────────────────────────────────────────
    if (key.downArrow) {
      if (showPopup) {
        setSelectedSuggestion((s) => Math.min(suggestions.length - 1, s + 1));
        return;
      }
      if (historyIndexRef.current <= 0) {
        setHistoryIndex(-1);
        setInput({ buffer: '', cursor: 0 });
      } else {
        const nextIdx = historyIndexRef.current - 1;
        setHistoryIndex(nextIdx);
        const entry = history[history.length - 1 - nextIdx];
        if (entry !== undefined) {
          setInput({ buffer: entry, cursor: entry.length });
        }
      }
      return;
    }

    // ── Left arrow / Ctrl+B ────────────────────────────────────────────────
    if (key.leftArrow || (key.ctrl && input === 'b')) {
      if (key.ctrl && input === 'b') {
        // word jump (Ctrl+Left / Alt+b): skip back over non-space chars then spaces
        setInput(({ buffer: b, cursor: c }) => {
          let i = c;
          while (i > 0 && b[i - 1] === ' ') i--;
          while (i > 0 && b[i - 1] !== ' ') i--;
          return { buffer: b, cursor: i };
        });
      } else {
        setInput(({ buffer: b, cursor: c }) => ({ buffer: b, cursor: Math.max(0, c - 1) }));
      }
      return;
    }

    // ── Right arrow / Ctrl+F ───────────────────────────────────────────────
    if (key.rightArrow || (key.ctrl && input === 'f')) {
      if (key.ctrl && input === 'f') {
        setInput(({ buffer: b, cursor: c }) => {
          let i = c;
          while (i < b.length && b[i] !== ' ') i++;
          while (i < b.length && b[i] === ' ') i++;
          return { buffer: b, cursor: i };
        });
      } else {
        setInput(({ buffer: b, cursor: c }) => ({ buffer: b, cursor: Math.min(b.length, c + 1) }));
      }
      return;
    }

    // ── Ctrl+A / Home: beginning of line ──────────────────────────────────
    if ((key.ctrl && input === 'a') || input === '\x1b[H') {
      setInput(({ buffer: b }) => ({ buffer: b, cursor: 0 }));
      return;
    }

    // ── Ctrl+E / End: end of line ─────────────────────────────────────────
    if ((key.ctrl && input === 'e') || input === '\x1b[F') {
      setInput(({ buffer: b }) => ({ buffer: b, cursor: b.length }));
      return;
    }

    // ── Ctrl+K: kill to end of line ───────────────────────────────────────
    if (key.ctrl && input === 'k') {
      setInput(({ buffer: b, cursor: c }) => ({ buffer: b.slice(0, c), cursor: c }));
      return;
    }

    // ── Ctrl+U: kill to beginning of line ─────────────────────────────────
    if (key.ctrl && input === 'u') {
      setInput(({ buffer: b, cursor: c }) => ({ buffer: b.slice(c), cursor: 0 }));
      return;
    }

    // ── Backspace ─────────────────────────────────────────────────────────
    if (key.backspace || key.delete) {
      setInput(({ buffer: b, cursor: c }) => {
        if (c === 0) return { buffer: b, cursor: c };
        return { buffer: b.slice(0, c - 1) + b.slice(c), cursor: c - 1 };
      });
      return;
    }

    // ── Regular character ─────────────────────────────────────────────────
    if (input && !key.ctrl && !key.meta) {
      setInput(({ buffer: b, cursor: c }) => ({
        buffer: b.slice(0, c) + input + b.slice(c),
        cursor: c + 1,
      }));
    }
  });

  const beforeCursor = buffer.slice(0, cursor);
  const atCursor    = buffer[cursor] ?? ' ';   // char under cursor (space if at end)
  const afterCursor = buffer.slice(cursor + 1);

  return (
    <Box flexDirection="column">
      {showPopup && suggestions.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginBottom={0}>
          {suggestions.map((cmd, i) => (
            <Box key={cmd}>
              <Text
                color={i === selectedSuggestion ? 'cyan' : undefined}
                dimColor={i !== selectedSuggestion}
                inverse={i === selectedSuggestion}
              >
                {'  /'}{cmd}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      <Box flexDirection="row">
        <Text color="cyan">{'  ❯ '}</Text>
        <Text>{beforeCursor}</Text>
        <Text inverse>{atCursor}</Text>
        <Text>{afterCursor}</Text>
      </Box>
    </Box>
  );
}
