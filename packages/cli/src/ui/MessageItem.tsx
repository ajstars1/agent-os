import React from 'react';
import { Box, Text } from 'ink';
import { renderMarkdown } from './markdown.js';

export type MessageEntry =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string; provider: string }
  | { type: 'tool_call'; name: string; preview: string; result?: string; elapsed?: number; isError?: boolean }
  | { type: 'memory_saved'; topic: string }
  | { type: 'error'; message: string }
  | { type: 'command_output'; text: string }
  | { type: 'thinking'; text: string };

// Human-readable verb for a tool name
const TOOL_VERB: Record<string, string> = {
  bash:        'Bash',
  glob:        'Glob',
  grep:        'Search',
  edit:        'Edit',
  read_file:   'Read',
  write_file:  'Write',
  ls:          'List',
  web_fetch:   'Fetch',
  remember:    'Remember',
};

function toolVerb(name: string): string {
  return TOOL_VERB[name] ?? name;
}

interface Props {
  message: MessageEntry;
}

export function MessageItem({ message }: Props): React.ReactElement {
  switch (message.type) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text bold color="white">{'  > '}</Text>
          <Text color="white">{message.text}</Text>
        </Box>
      );

    case 'assistant': {
      const rendered = renderMarkdown(message.text);
      const providerColor: 'green' | 'cyan' = message.provider === 'gemini' ? 'green' : 'cyan';
      return (
        <Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={2}>
          {rendered.split('\n').map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
          <Text dimColor color={providerColor} >
            {'─── '}{message.provider}
          </Text>
        </Box>
      );
    }

    case 'tool_call': {
      const verb = toolVerb(message.name);
      const elapsedStr = message.elapsed !== undefined
        ? message.elapsed >= 1000
          ? `${(message.elapsed / 1000).toFixed(1)}s`
          : `${message.elapsed}ms`
        : '';
      const resultStr = message.result ? `  ${message.result}` : '';

      return (
        <Box flexDirection="column" marginLeft={2}>
          <Box>
            <Text color={message.isError ? 'red' : 'cyan'}>
              {message.isError ? '  ✗ ' : '  ✓ '}
            </Text>
            <Text color="cyan">{verb}</Text>
            {message.preview ? <Text dimColor>{'  '}{message.preview}</Text> : null}
            {elapsedStr ? <Text dimColor>{'  · '}{elapsedStr}</Text> : null}
          </Box>
          {message.result && (
            <Text dimColor>{'    └ '}{resultStr.trim()}</Text>
          )}
        </Box>
      );
    }

    case 'memory_saved':
      return (
        <Box marginLeft={2}>
          <Text color="magenta">{'  ◆ '}</Text>
          <Text dimColor>saved &quot;{message.topic}&quot;</Text>
        </Box>
      );

    case 'error':
      return (
        <Box marginLeft={2} marginTop={1}>
          <Text color="red">{'  ✗  '}{message.message}</Text>
        </Box>
      );

    case 'command_output':
      return (
        <Box flexDirection="column" marginLeft={2} marginTop={0} marginBottom={1}>
          {message.text.split('\n').map((line, i) => (
            <Text key={i} dimColor>{line ? `  ${line}` : ''}</Text>
          ))}
        </Box>
      );

    case 'thinking':
      return (
        <Box flexDirection="column" marginLeft={2} marginTop={0} marginBottom={1}>
          <Text dimColor color="yellow">{'  ◐ thought'}</Text>
          {message.text.split('\n').slice(0, 10).map((line, i) => (
            <Text key={i} dimColor>{`    ${line}`}</Text>
          ))}
        </Box>
      );
  }
}
