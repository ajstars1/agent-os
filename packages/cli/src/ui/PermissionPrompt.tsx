import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { PermissionDecision } from '@agent-os-core/shared';

interface Props {
  toolName: string;
  input: Record<string, unknown>;
  preview: string;
  onDecision: (decision: PermissionDecision) => void;
}

const TOOL_ICONS: Record<string, string> = {
  bash: '❯',
  edit: '✎',
  write_file: '◉',
};

export function PermissionPrompt({ toolName, preview, onDecision }: Props): React.ReactElement {
  const [selected, setSelected] = useState<0 | 1 | 2>(0); // 0=allow, 1=always, 2=deny

  useInput((input, key) => {
    if (key.leftArrow) {
      setSelected((s) => (s === 0 ? 2 : (s - 1) as 0 | 1 | 2));
      return;
    }
    if (key.rightArrow) {
      setSelected((s) => (s === 2 ? 0 : (s + 1) as 0 | 1 | 2));
      return;
    }
    if (key.return || input === 'y') {
      onDecision(selected === 0 ? 'allow' : selected === 1 ? 'always' : 'deny');
      return;
    }
    if (input === 'n') { onDecision('deny'); return; }
    if (input === 'a') { onDecision('always'); return; }
    if (key.escape) { onDecision('deny'); return; }
    // Number shortcuts
    if (input === '1') { onDecision('allow'); return; }
    if (input === '2') { onDecision('always'); return; }
    if (input === '3') { onDecision('deny'); return; }
  });

  const icon = TOOL_ICONS[toolName] ?? '⚙';
  const options: Array<{ key: PermissionDecision; label: string; shortcut: string }> = [
    { key: 'allow', label: 'Allow once', shortcut: 'y/1' },
    { key: 'always', label: 'Always allow', shortcut: 'a/2' },
    { key: 'deny', label: 'Deny', shortcut: 'n/3' },
  ];

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} paddingX={2}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="yellow">{'⚠ Permission Required'}</Text>
      </Box>

      {/* Tool name */}
      <Box marginBottom={1}>
        <Text color="cyan">{icon} </Text>
        <Text bold>{toolName}</Text>
      </Box>

      {/* Preview lines */}
      <Box flexDirection="column" marginLeft={2} marginBottom={1}
        borderStyle="single" borderColor="gray" paddingX={1}>
        {preview.split('\n').map((line, i) => {
          const isRemoved = line.startsWith('- ');
          const isAdded = line.startsWith('+ ');
          return (
            <Text
              key={i}
              color={isRemoved ? 'red' : isAdded ? 'green' : undefined}
              dimColor={!isRemoved && !isAdded}
            >
              {line}
            </Text>
          );
        })}
      </Box>

      {/* Option buttons */}
      <Box flexDirection="row" marginTop={1}>
        {options.map((opt, i) => (
          <Box key={opt.key} marginRight={2}>
            <Text
              inverse={i === selected}
              color={i === selected ? (opt.key === 'deny' ? 'red' : opt.key === 'always' ? 'magenta' : 'green') : undefined}
              dimColor={i !== selected}
            >
              {` ${opt.label} [${opt.shortcut}] `}
            </Text>
          </Box>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>{'← → to select  ·  Enter to confirm  ·  Esc to deny'}</Text>
      </Box>
    </Box>
  );
}
