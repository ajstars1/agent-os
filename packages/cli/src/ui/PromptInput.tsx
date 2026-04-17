import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useStdin, useStdout } from 'ink';
import { feedKeypress, INITIAL_STATE, type KeyEvent, type KeypressState } from './keypress.js';

const BASE_COMMANDS = [
  'help', 'clear', 'model', 'config', 'cd', 'cwd', 'dream',
  'agents', 'skills', 'memory', 'feedback', 'export', 'exit',
];

// ── Paste handling ────────────────────────────────────────────────────────────
// Ported from Claude Code (src/history.ts + components/PromptInput/PromptInput.tsx).
// Pastes over PASTE_THRESHOLD chars or spanning multiple lines are replaced in
// the visible buffer with a [Pasted text #N] placeholder; the full content is
// stored in pastedContents and expanded back in on submit.
const PASTE_THRESHOLD = 800;
const PASTE_MAX_INLINE_LINES = 2;

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function normalizePastedText(raw: string): string {
  return stripAnsi(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replaceAll('\t', '    ');
}

function getPastedTextRefNumLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length;
}

function formatPastedTextRef(id: number, numLines: number): string {
  if (numLines === 0) return `[Pasted text #${id}]`;
  return `[Pasted text #${id} +${numLines} lines]`;
}

function expandPastedTextRefs(
  input: string,
  pastedContents: Record<number, string>,
): string {
  const pattern = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g;
  return input.replace(pattern, (match, idStr: string) => {
    const id = parseInt(idStr, 10);
    return pastedContents[id] ?? match;
  });
}

// Terminal mode control: enable bracketed paste + xterm modifyOtherKeys +
// kitty keyboard protocol so Shift+Enter / Alt+Enter emit distinct sequences.
const ENABLE_TERM_MODES = '\x1b[?2004h\x1b[>4;2m\x1b[>1u';
const DISABLE_TERM_MODES = '\x1b[?2004l\x1b[>4m\x1b[<u';

interface PasteRef {
  id: number;
  content: string;
}

// ── @-file reference detection ────────────────────────────────────────────────
function isImagePath(p: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(p);
}

function extractAtMention(buffer: string, cursor: number): { path: string; start: number } | null {
  let i = cursor - 1;
  while (i >= 0 && buffer[i] !== '@' && buffer[i] !== ' ' && buffer[i] !== '\n') i--;
  if (i < 0 || buffer[i] !== '@') return null;
  const path = buffer.slice(i + 1, cursor);
  if (path.length < 1) return null;
  return { path, start: i };
}

// ── Visual wrapping ───────────────────────────────────────────────────────────
interface VisualLine {
  text: string;
  absStart: number;
  logicalLineIdx: number;
  wrapIdx: number;
}

interface Layout {
  visualLines: VisualLine[];
  cursorLine: number;
  cursorCol: number;
}

function computeLayout(buffer: string, cursor: number, width: number): Layout {
  const visualLines: VisualLine[] = [];
  const logicalLines = buffer.split('\n');
  let abs = 0;
  for (let li = 0; li < logicalLines.length; li++) {
    const logical = logicalLines[li] ?? '';
    if (logical.length === 0) {
      visualLines.push({ text: '', absStart: abs, logicalLineIdx: li, wrapIdx: 0 });
    } else {
      for (let i = 0, wi = 0; i < logical.length; i += width, wi++) {
        visualLines.push({
          text: logical.slice(i, i + width),
          absStart: abs + i,
          logicalLineIdx: li,
          wrapIdx: wi,
        });
      }
    }
    abs += logical.length + (li < logicalLines.length - 1 ? 1 : 0);
  }

  if (visualLines.length === 0) {
    visualLines.push({ text: '', absStart: 0, logicalLineIdx: 0, wrapIdx: 0 });
  }

  let cursorLine = visualLines.length - 1;
  let cursorCol = (visualLines[cursorLine]?.text.length) ?? 0;
  for (let i = 0; i < visualLines.length; i++) {
    const vl = visualLines[i];
    if (!vl) continue;
    const start = vl.absStart;
    const end = start + vl.text.length;
    if (cursor >= start && cursor < end) {
      cursorLine = i;
      cursorCol = cursor - start;
      break;
    }
    if (cursor === end) {
      const next = visualLines[i + 1];
      const endsLogical = !next || next.logicalLineIdx !== vl.logicalLineIdx;
      if (endsLogical) {
        cursorLine = i;
        cursorCol = cursor - start;
        break;
      }
    }
  }
  return { visualLines, cursorLine, cursorCol };
}

// ── Input state ───────────────────────────────────────────────────────────────
interface InputState {
  buffer: string;
  cursor: number;
}

interface Props {
  onSubmit: (value: string, pasteRefs: PasteRef[]) => void;
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
  const [{ buffer, cursor }, setInput] = useState<InputState>({ buffer: '', cursor: 0 });
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [showPopup, setShowPopup] = useState(false);
  const [pastedContents, setPastedContents] = useState<Record<number, string>>({});
  const [isMultiLine, setIsMultiLine] = useState(false);

  const historyIndexRef = useRef(historyIndex);
  historyIndexRef.current = historyIndex;
  const nextPasteIdRef = useRef(1);
  const parseStateRef = useRef<KeypressState>(INITIAL_STATE);

  // Latest state refs — so the stdin listener (registered once) sees fresh values.
  const stateRef = useRef({ buffer, cursor, showPopup, suggestions, selectedSuggestion, isMultiLine, pastedContents, isDisabled });
  stateRef.current = { buffer, cursor, showPopup, suggestions, selectedSuggestion, isMultiLine, pastedContents, isDisabled };

  const allCommands = [...new Set([...BASE_COMMANDS, ...commands])];

  // Enable terminal protocols on mount, disable on unmount.
  useEffect(() => {
    process.stdout.write(ENABLE_TERM_MODES);
    return () => { process.stdout.write(DISABLE_TERM_MODES); };
  }, []);

  const insertPastedText = useCallback((raw: string): void => {
    const cleaned = normalizePastedText(raw);
    if (cleaned.length === 0) return;
    const numLines = getPastedTextRefNumLines(cleaned);
    const shouldPlaceholder = cleaned.length >= PASTE_THRESHOLD || numLines >= PASTE_MAX_INLINE_LINES;
    if (shouldPlaceholder) {
      const id = nextPasteIdRef.current++;
      setPastedContents((prev) => ({ ...prev, [id]: cleaned }));
      const placeholder = formatPastedTextRef(id, numLines);
      setInput(({ buffer: b, cursor: c }) => ({
        buffer: b.slice(0, c) + placeholder + b.slice(c),
        cursor: c + placeholder.length,
      }));
    } else {
      setInput(({ buffer: b, cursor: c }) => ({
        buffer: b.slice(0, c) + cleaned + b.slice(c),
        cursor: c + cleaned.length,
      }));
    }
  }, []);

  useEffect(() => {
    if (buffer.startsWith('/')) {
      const firstLine = buffer.split('\n')[0] ?? buffer;
      const matches = getMatchingCommands(firstLine, allCommands);
      setSuggestions(matches.slice(0, 6));
      setShowPopup(matches.length > 0 && firstLine.length > 1);
      setSelectedSuggestion(0);
    } else {
      setShowPopup(false);
      setSuggestions([]);
    }
    setIsMultiLine(buffer.includes('\n'));
  }, [buffer]); // eslint-disable-line react-hooks/exhaustive-deps

  const reset = useCallback((newBuffer = '', newCursor = 0): void => {
    setInput({ buffer: newBuffer, cursor: newCursor });
    setHistoryIndex(-1);
    setShowPopup(false);
    setPastedContents({});
    setIsMultiLine(false);
    nextPasteIdRef.current = 1;
  }, []);

  const handleSubmit = useCallback((submitBuffer: string, submitPasted: Record<number, string>): void => {
    if (!submitBuffer.trim()) return;
    const expanded = expandPastedTextRefs(submitBuffer.trim(), submitPasted);
    const refs: PasteRef[] = Object.entries(submitPasted).map(([id, content]) => ({
      id: Number(id), content,
    }));
    reset();
    onSubmit(expanded, refs);
  }, [onSubmit, reset]);

  // ── Raw stdin keypress handler ──────────────────────────────────────────────
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  useEffect(() => {
    if (!stdin || !isRawModeSupported) return;
    setRawMode(true);

    const handleKey = (ev: KeyEvent): void => {
      const s = stateRef.current;
      if (s.isDisabled) return;

      // ── Paste ───────────────────────────────────────────────────────────
      if (ev.kind === 'paste') {
        insertPastedText(ev.sequence);
        return;
      }

      // ── Return / Shift+Return / Alt+Return ─────────────────────────────
      if (ev.name === 'return') {
        if (ev.shift || ev.meta) {
          // Newline
          setInput(({ buffer: b, cursor: c }) => ({
            buffer: b.slice(0, c) + '\n' + b.slice(c),
            cursor: c + 1,
          }));
          return;
        }
        // Submit (with suggestion if popup open)
        if (s.showPopup && s.suggestions.length > 0) {
          const chosen = s.suggestions[s.selectedSuggestion];
          if (chosen !== undefined) {
            reset();
            onSubmit('/' + chosen, []);
            return;
          }
        }
        handleSubmit(s.buffer, s.pastedContents);
        return;
      }

      // ── Tab: cycle suggestions ─────────────────────────────────────────
      if (ev.name === 'tab') {
        if (s.showPopup && s.suggestions.length > 0) {
          const next = (s.selectedSuggestion + 1) % s.suggestions.length;
          setSelectedSuggestion(next);
          const chosen = s.suggestions[next];
          if (chosen !== undefined) {
            const completed = '/' + chosen;
            setInput({ buffer: completed, cursor: completed.length });
          }
        }
        return;
      }

      // ── Escape ─────────────────────────────────────────────────────────
      if (ev.name === 'escape') {
        if (s.showPopup) setShowPopup(false);
        return;
      }

      // ── Up ─────────────────────────────────────────────────────────────
      if (ev.name === 'up') {
        if (s.showPopup) {
          setSelectedSuggestion((x) => Math.max(0, x - 1));
          return;
        }
        if (s.isMultiLine) {
          setInput(({ buffer: b, cursor: c }) => {
            const before = b.slice(0, c);
            const prevNl = before.lastIndexOf('\n');
            if (prevNl === -1) return { buffer: b, cursor: c };
            const prevPrevNl = before.lastIndexOf('\n', prevNl - 1);
            const colInCurrent = c - prevNl - 1;
            const newLineStart = prevPrevNl + 1;
            const prevLineLen = prevNl - newLineStart;
            return { buffer: b, cursor: newLineStart + Math.min(colInCurrent, prevLineLen) };
          });
          return;
        }
        const nextIdx = Math.min(historyIndexRef.current + 1, history.length - 1);
        setHistoryIndex(nextIdx);
        const entry = history[history.length - 1 - nextIdx];
        if (entry !== undefined) setInput({ buffer: entry, cursor: entry.length });
        return;
      }

      // ── Down ───────────────────────────────────────────────────────────
      if (ev.name === 'down') {
        if (s.showPopup) {
          setSelectedSuggestion((x) => Math.min(s.suggestions.length - 1, x + 1));
          return;
        }
        if (s.isMultiLine) {
          setInput(({ buffer: b, cursor: c }) => {
            const before = b.slice(0, c);
            const prevNl = before.lastIndexOf('\n');
            const nextNl = b.indexOf('\n', c);
            if (nextNl === -1) return { buffer: b, cursor: b.length };
            const colInCurrent = c - prevNl - 1;
            const lineAfterNext = b.indexOf('\n', nextNl + 1);
            const nextLineEnd = lineAfterNext === -1 ? b.length : lineAfterNext;
            return { buffer: b, cursor: nextNl + 1 + Math.min(colInCurrent, nextLineEnd - nextNl - 1) };
          });
          return;
        }
        if (historyIndexRef.current <= 0) {
          setHistoryIndex(-1);
          setInput({ buffer: '', cursor: 0 });
        } else {
          const nextIdx = historyIndexRef.current - 1;
          setHistoryIndex(nextIdx);
          const entry = history[history.length - 1 - nextIdx];
          if (entry !== undefined) setInput({ buffer: entry, cursor: entry.length });
        }
        return;
      }

      // ── Left / Ctrl+B ──────────────────────────────────────────────────
      if (ev.name === 'left' || (ev.ctrl && ev.name === 'b')) {
        if (ev.ctrl && ev.name === 'b') {
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

      // ── Right / Ctrl+F ─────────────────────────────────────────────────
      if (ev.name === 'right' || (ev.ctrl && ev.name === 'f')) {
        if (ev.ctrl && ev.name === 'f') {
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

      // ── Home / Ctrl+A ──────────────────────────────────────────────────
      if (ev.name === 'home' || (ev.ctrl && ev.name === 'a')) {
        setInput(({ buffer: b, cursor: c }) => {
          if (s.isMultiLine) {
            const before = b.slice(0, c);
            const prevNl = before.lastIndexOf('\n');
            return { buffer: b, cursor: prevNl + 1 };
          }
          return { buffer: b, cursor: 0 };
        });
        return;
      }

      // ── End / Ctrl+E ───────────────────────────────────────────────────
      if (ev.name === 'end' || (ev.ctrl && ev.name === 'e')) {
        setInput(({ buffer: b, cursor: c }) => {
          if (s.isMultiLine) {
            const nextNl = b.indexOf('\n', c);
            return { buffer: b, cursor: nextNl === -1 ? b.length : nextNl };
          }
          return { buffer: b, cursor: b.length };
        });
        return;
      }

      // ── Ctrl+K: kill to EOL ───────────────────────────────────────────
      if (ev.ctrl && ev.name === 'k') {
        setInput(({ buffer: b, cursor: c }) => {
          if (s.isMultiLine) {
            const nextNl = b.indexOf('\n', c);
            const end = nextNl === -1 ? b.length : nextNl;
            return { buffer: b.slice(0, c) + b.slice(end), cursor: c };
          }
          return { buffer: b.slice(0, c), cursor: c };
        });
        return;
      }

      // ── Ctrl+U: kill to BOL ───────────────────────────────────────────
      if (ev.ctrl && ev.name === 'u') {
        setInput(({ buffer: b, cursor: c }) => {
          if (s.isMultiLine) {
            const before = b.slice(0, c);
            const prevNl = before.lastIndexOf('\n');
            const lineStart = prevNl + 1;
            return { buffer: b.slice(0, lineStart) + b.slice(c), cursor: lineStart };
          }
          return { buffer: b.slice(c), cursor: 0 };
        });
        return;
      }

      // ── Ctrl+L: clear ─────────────────────────────────────────────────
      if (ev.ctrl && ev.name === 'l') {
        reset();
        return;
      }

      // ── Ctrl+C: pass through to Ink/process so it can exit ────────────
      if (ev.ctrl && ev.name === 'c') {
        // Re-emit SIGINT so the main app's exit flow runs.
        process.kill(process.pid, 'SIGINT');
        return;
      }

      // ── Backspace / Delete ────────────────────────────────────────────
      if (ev.name === 'backspace' || ev.name === 'delete') {
        setInput(({ buffer: b, cursor: c }) => {
          if (c === 0) return { buffer: b, cursor: c };
          return { buffer: b.slice(0, c - 1) + b.slice(c), cursor: c - 1 };
        });
        return;
      }

      // ── Printable character ──────────────────────────────────────────
      if (ev.sequence && !ev.ctrl && !ev.meta && ev.sequence.length > 0) {
        setInput(({ buffer: b, cursor: c }) => ({
          buffer: b.slice(0, c) + ev.sequence + b.slice(c),
          cursor: c + ev.sequence.length,
        }));
        return;
      }
    };

    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const result = feedKeypress(parseStateRef.current, s);
      parseStateRef.current = result.state;
      for (const ev of result.events) {
        handleKey(ev);
      }
    };

    stdin.on('data', onData);
    return () => { stdin.off('data', onData); };
  }, [stdin, isRawModeSupported, setRawMode, insertPastedText, handleSubmit, reset, onSubmit, history]);

  // ── Render ────────────────────────────────────────────────────────────
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const PREFIX_WIDTH = 4;
  const RIGHT_MARGIN = 2;
  const contentWidth = Math.max(20, cols - PREFIX_WIDTH - RIGHT_MARGIN);

  const { visualLines, cursorLine, cursorCol } = computeLayout(buffer, cursor, contentWidth);
  const hasWrappedContent = visualLines.length > 1;

  const atMention = extractAtMention(buffer, cursor);
  const atMentionIsImage = atMention ? isImagePath(atMention.path) : false;

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

      {isMultiLine && (
        <Box marginLeft={6}>
          <Text dimColor>{'[multi-line: Shift+Enter / Alt+Enter = newline, Enter = submit]'}</Text>
        </Box>
      )}

      {visualLines.map((vl, vlIdx) => {
        const isCursorLine = vlIdx === cursorLine;
        const isFirstVisual = vlIdx === 0;
        const isLogicalStart = vl.wrapIdx === 0;
        const prefix = isFirstVisual
          ? '  ❯ '
          : isLogicalStart
            ? '  … '
            : '    ';
        const prefixEl = isFirstVisual ? (
          <Text color="cyan">{prefix}</Text>
        ) : (
          <Text color="cyan" dimColor>{prefix}</Text>
        );
        const beforeCursor = isCursorLine ? vl.text.slice(0, cursorCol) : vl.text;
        const atCursorChar = isCursorLine ? (vl.text[cursorCol] ?? ' ') : '';
        const afterCursor = isCursorLine ? vl.text.slice(cursorCol + 1) : '';
        return (
          <Box key={vlIdx} flexDirection="row">
            {prefixEl}
            {isCursorLine ? (
              <>
                <Text>{beforeCursor}</Text>
                <Text inverse>{atCursorChar}</Text>
                <Text>{afterCursor}</Text>
              </>
            ) : (
              <Text>{vl.text}</Text>
            )}
          </Box>
        );
      })}

      {hasWrappedContent && !isMultiLine && (
        <Box marginLeft={6}>
          <Text dimColor>{`[${visualLines.length} lines wrapped]`}</Text>
        </Box>
      )}

      {atMention && (
        <Box marginLeft={6}>
          <Text color={atMentionIsImage ? 'magenta' : 'cyan'} dimColor>
            {atMentionIsImage ? '◎ image: ' : '◎ file: '}{atMention.path}
          </Text>
        </Box>
      )}

      {Object.keys(pastedContents).length > 0 && (
        <Box marginLeft={6}>
          <Text dimColor>
            {`${Object.keys(pastedContents).length} pasted text reference${Object.keys(pastedContents).length > 1 ? 's' : ''} (expanded on submit)`}
          </Text>
        </Box>
      )}
    </Box>
  );
}
