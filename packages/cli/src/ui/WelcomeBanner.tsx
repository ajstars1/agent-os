import React from 'react';
import { Box, Text } from 'ink';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const LOGO = `   ▗▄▖  ▗▄▄▖  ▗▄▄▖
  ▐▌ ▐▌▐▌   ▐▌
  ▐▛▀▜▌▐▌▝▜▌ ▝▀▚▖
  ▐▌ ▐▌▝▚▄▞▘▗▄▄▞▘`;

interface GitInfo {
  branch: string;
  dirty: boolean;
  ahead: number;
}

function getGitInfo(): GitInfo | null {
  try {
    const branch = execSync('git branch --show-current 2>/dev/null', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!branch) return null;
    const status = execSync('git status --porcelain 2>/dev/null', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const dirty = status.length > 0;
    let ahead = 0;
    try {
      const aheadStr = execSync('git rev-list --count @{u}..HEAD 2>/dev/null', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      ahead = parseInt(aheadStr, 10) || 0;
    } catch { /* no upstream */ }
    return { branch, dirty, ahead };
  } catch {
    return null;
  }
}

interface Props {
  projectName: string;
  model: string;
  skillCount: number;
  memoryCount: number;
}

export function WelcomeBanner({ projectName, model, skillCount, memoryCount }: Props): React.ReactElement {
  const cwdShort = process.cwd().replace(homedir(), '~');
  const git = getGitInfo();

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Logo */}
      {LOGO.split('\n').map((line, i) => (
        <Text key={i} color="magenta">{'  '}{line}</Text>
      ))}

      {/* Metadata row 1: project + cwd */}
      <Box marginTop={1}>
        <Text dimColor>{'  project  '}</Text>
        <Text bold color="white">{projectName}</Text>
        <Text dimColor>{'    cwd  '}</Text>
        <Text dimColor>{cwdShort}</Text>
      </Box>

      {/* Metadata row 2: model + git + skills + memory */}
      <Box>
        <Text dimColor>{'  model    '}</Text>
        <Text color="cyan">{model}</Text>
        {git && (
          <>
            <Text dimColor>{'    git  '}</Text>
            <Text color={git.dirty ? 'yellow' : 'green'}>{git.branch}</Text>
            {git.dirty && <Text color="yellow">{'*'}</Text>}
            {git.ahead > 0 && <Text dimColor>{` ↑${git.ahead}`}</Text>}
          </>
        )}
        <Text dimColor>{'    skills  '}</Text>
        <Text dimColor>{String(skillCount)}</Text>
        <Text dimColor>{'    memory  '}</Text>
        <Text dimColor>{String(memoryCount)} topics</Text>
      </Box>

      {/* Divider */}
      <Text dimColor>{'  ' + '─'.repeat(52)}</Text>

      {/* Tips */}
      <Box>
        <Text dimColor>{'  type a message, or '}</Text>
        <Text color="cyan">/help</Text>
        <Text dimColor>{' for commands, '}</Text>
        <Text color="cyan">/skillname</Text>
        <Text dimColor>{' to invoke a skill'}</Text>
      </Box>
    </Box>
  );
}
