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
        <Box marginTop={1} marginLeft={1}>
          <Text bold color="cyan">{'❯ '}</Text>
          <Text bold color="white">{message.text}</Text>
        </Box>
      );

    case 'assistant': {
      const rendered = renderMarkdown(message.text);
      const providerColor = message.provider === 'gemini' ? 'green' : 'blue';
      const providerName = message.provider.charAt(0).toUpperCase() + message.provider.slice(1);
      
      return (
        <Box 
          flexDirection="column" 
          marginTop={1} 
          marginBottom={1}
          borderStyle="round" 
          borderColor={providerColor}
          paddingX={1}
        >
          <Box marginBottom={1}>
            <Text dimColor color={providerColor}>{'✦ '}{providerName}</Text>
          </Box>
          <Box flexDirection="column">
            {rendered.split('\n').map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </Box>
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
      
      const borderColor = message.isError ? 'red' : 'dim';
      const resultColor = message.isError ? 'red' : undefined;

      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Box>
            <Text color={message.isError ? 'red' : 'yellow'}>
              {message.isError ? '✗ ' : '⚙ '}
            </Text>
            <Text color="yellow" bold>{verb}</Text>
            {message.preview ? <Text dimColor>{'  '}{message.preview}</Text> : null}
            {elapsedStr ? <Text dimColor>{'  · '}{elapsedStr}</Text> : null}
          </Box>
          {message.result && (
            <Box marginTop={0} marginLeft={2} borderStyle="round" borderColor={borderColor} paddingX={1}>
               <Text dimColor={!message.isError} color={resultColor}>{message.result.trim()}</Text>
            </Box>
          )}
        </Box>
      );
    }

    case 'memory_saved':
      return (
        <Box marginLeft={2} marginTop={1}>
          <Text color="magenta">{'✦ '}</Text>
          <Text dimColor>Saved to memory: </Text>
          <Text color="magenta">&quot;{message.topic}&quot;</Text>
        </Box>
      );

    case 'error':
      return (
        <Box marginLeft={2} marginTop={1} borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red" bold>{'✗ Error: '}</Text>
          <Text color="red">{message.message}</Text>
        </Box>
      );

    case 'command_output':
      return (
        <Box flexDirection="column" marginLeft={2} marginTop={1} marginBottom={1} borderStyle="round" borderColor="dim" paddingX={1}>
          {message.text.split('\n').map((line, i) => (
            <Text key={i} dimColor>{line}</Text>
          ))}
        </Box>
      );

    case 'thinking':
      return (
        <Box flexDirection="column" marginLeft={2} marginTop={1} marginBottom={1} borderStyle="single" borderColor="dim" borderTop={false} borderBottom={false} borderRight={false} paddingLeft={1}>
          <Text dimColor color="yellow" bold>{'◐ Thought Process'}</Text>
          {message.text.split('\n').map((line, i) => (
            <Text key={i} dimColor>{line}</Text>
          ))}
        </Box>
      );
  }
}
