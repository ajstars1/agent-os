/**
 * MessageItem v2 — clean, modern message rendering for the AgentOS v2 UI.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { MarkdownView } from './MarkdownView.js';

export type MessageEntry =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string; provider: string; model?: string; elapsedMs?: number }
  | { type: 'tool_call'; name: string; preview: string; result?: string; elapsed?: number; isError?: boolean }
  | { type: 'memory_saved'; topic: string }
  | { type: 'error'; message: string }
  | { type: 'command_output'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'status'; text: string };

// ─── Provider colours ─────────────────────────────────────────────────────────

function providerColor(provider: string): string {
  if (provider === 'gemini')      return 'green';
  if (provider === 'openrouter')  return 'yellow';
  if (provider === 'ollama')      return 'magenta';
  return 'blueBright';
}

function providerLabel(provider: string, model?: string): string {
  if (model) return model;
  const labels: Record<string, string> = {
    claude:      'claude',
    gemini:      'gemini',
    openrouter:  'openrouter',
    ollama:      'ollama',
  };
  return labels[provider] ?? provider;
}

// ─── Tool verb map ────────────────────────────────────────────────────────────

const TOOL_ICON: Record<string, string> = {
  bash:              '⚡',
  read_file:         '📖',
  write_file:        '✏',
  edit:              '✏',
  glob:              '🔍',
  grep:              '🔍',
  web_fetch:         '🌐',
  web_search:        '🌐',
  browser_navigate:  '🌐',
  browser_snapshot:  '📸',
  remember:          '🧠',
  delegate_task:     '👥',
  generate_image:    '🖼',
  analyze_image:     '👁',
};

function toolIcon(name: string): string {
  return TOOL_ICON[name] ?? '⚙';
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Components ───────────────────────────────────────────────────────────────

interface Props { message: MessageEntry }

export function MessageItem({ message }: Props): React.ReactElement {
  switch (message.type) {

    // ── User ──────────────────────────────────────────────────────────────────
    case 'user':
      return (
        <Box marginTop={1} marginLeft={1} flexDirection="row">
          <Text bold color="cyan">❯  </Text>
          <Box flexDirection="column">
            {message.text.split('\n').map((line, i) => (
              <Text key={i} bold color="white">{line}</Text>
            ))}
          </Box>
        </Box>
      );

    // ── Assistant ─────────────────────────────────────────────────────────────
    case 'assistant': {
      const color = providerColor(message.provider);
      const label = providerLabel(message.provider, message.model);
      const elapsed = message.elapsedMs ? fmtElapsed(message.elapsedMs) : '';

      return (
        <Box
          flexDirection="column"
          marginTop={1}
          marginLeft={1}
          borderStyle="round"
          borderColor={color}
          paddingX={1}
          paddingY={0}
        >
          {/* Provider header */}
          <Box marginBottom={1}>
            <Text bold color={color}>✦ {label}</Text>
            {elapsed && <Text dimColor>{'  ·  '}{elapsed}</Text>}
          </Box>
          {/* Markdown content */}
          <MarkdownView markdown={message.text} />
        </Box>
      );
    }

    // ── Tool call ─────────────────────────────────────────────────────────────
    case 'tool_call': {
      const icon = toolIcon(message.name);
      const elapsed = message.elapsed !== undefined ? fmtElapsed(message.elapsed) : '';
      const statusIcon = message.isError ? '✗' : '✓';
      const statusColor = message.isError ? 'red' : 'green';

      return (
        <Box flexDirection="column" marginTop={0} marginLeft={3}>
          {/* Tool header line */}
          <Box>
            <Text dimColor>{icon} </Text>
            <Text dimColor bold>{message.name}</Text>
            {message.preview ? <Text dimColor>{'  '}{message.preview}</Text> : null}
            <Text dimColor>{elapsed ? `  ${elapsed}` : ''}</Text>
            <Text color={statusColor} dimColor>{'  '}{statusIcon}</Text>
          </Box>
          {/* Error output only */}
          {message.result && message.isError && (
            <Box marginLeft={3} borderStyle="single" borderColor="red" paddingX={1}>
              <Text color="red">{message.result}</Text>
            </Box>
          )}
        </Box>
      );
    }

    // ── Memory saved ──────────────────────────────────────────────────────────
    case 'memory_saved':
      return (
        <Box marginLeft={3} marginTop={0}>
          <Text dimColor color="magenta">✦ memory  </Text>
          <Text dimColor>&quot;{message.topic}&quot;</Text>
        </Box>
      );

    // ── Error ─────────────────────────────────────────────────────────────────
    case 'error':
      return (
        <Box
          marginTop={1}
          marginLeft={1}
          borderStyle="round"
          borderColor="red"
          paddingX={1}
        >
          <Text color="red" bold>✗  </Text>
          <Text color="red">{message.message}</Text>
        </Box>
      );

    // ── Command output ────────────────────────────────────────────────────────
    case 'command_output':
      return (
        <Box
          flexDirection="column"
          marginTop={1}
          marginLeft={1}
          borderStyle="single"
          borderColor="dim"
          paddingX={1}
        >
          {message.text.split('\n').map((line, i) => (
            <Text key={i} dimColor>{line}</Text>
          ))}
        </Box>
      );

    // ── Thinking ──────────────────────────────────────────────────────────────
    case 'thinking':
      return (
        <Box
          flexDirection="column"
          marginTop={1}
          marginLeft={1}
          borderStyle="single"
          borderColor="dim"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          paddingLeft={1}
        >
          <Text dimColor bold>◈ thinking</Text>
          {message.text.split('\n').slice(0, 12).map((line, i) => (
            <Text key={i} dimColor>{line}</Text>
          ))}
        </Box>
      );

    // ── Status ────────────────────────────────────────────────────────────────
    case 'status':
      return (
        <Box marginLeft={3} marginTop={0}>
          <Text dimColor>◌ {message.text}</Text>
        </Box>
      );
  }
}
