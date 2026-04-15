#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import * as rl from 'node:readline/promises';
import dotenv from 'dotenv';
import React from 'react';
import { render } from 'ink';

// ─── Env resolution ───────────────────────────────────────────────────────────
// Priority (non-overriding): ~/.agent-os/.env → walk up cwd for .env → script-adjacent .env
function resolveEnv(): void {
  const globalEnv = join(homedir(), '.agent-os', '.env');
  if (existsSync(globalEnv)) dotenv.config({ path: globalEnv, override: false });

  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) { dotenv.config({ path: candidate, override: false }); break; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectEnv = resolve(scriptDir, '../../../.env');
  if (existsSync(projectEnv)) dotenv.config({ path: projectEnv, override: false });
}

resolveEnv();

import { loadConfig } from '@agent-os/shared';
import { bootstrap } from '@agent-os/core';
import { App } from './ui/App.js';

// ─── Args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { agent?: string; model?: string } {
  const result: { agent?: string; model?: string } = {};
  for (let i = 2; i < argv.length; i++) {
    if ((argv[i] === '--agent' || argv[i] === '-a') && argv[i + 1]) {
      result.agent = argv[i + 1]; i++;
    } else if ((argv[i] === '--model' || argv[i] === '-m') && argv[i + 1]) {
      result.model = argv[i + 1]; i++;
    }
  }
  return result;
}

// ─── First-run setup ──────────────────────────────────────────────────────────

const ENV_PATH = join(homedir(), '.agent-os', '.env');

async function firstRunSetup(): Promise<void> {
  const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
  const ESC = '\x1b';
  const cyan  = (s: string): string => `${ESC}[36m${s}${ESC}[0m`;
  const dim   = (s: string): string => `${ESC}[2m${s}${ESC}[0m`;
  const bold  = (s: string): string => `${ESC}[1m${s}${ESC}[0m`;
  const green = (s: string): string => `${ESC}[32m${s}${ESC}[0m`;

  process.stdout.write('\n');
  process.stdout.write(`  ${bold(cyan('AgentOS'))} — first run setup\n`);
  process.stdout.write(`  ${dim('─────────────────────────────────────')}\n\n`);
  process.stdout.write(`  ${dim('Config will be saved to:')} ${ENV_PATH}\n\n`);

  const apiKey = await iface.question(`  Anthropic API key ${dim('(sk-ant-...)')}  `);
  const trimmed = apiKey.trim();

  if (!trimmed || !trimmed.startsWith('sk-')) {
    process.stdout.write(`\n  ${dim('Skipped. Set ANTHROPIC_API_KEY in')} ${ENV_PATH}\n\n`);
    iface.close();
    process.exit(0);
  }

  mkdirSync(dirname(ENV_PATH), { recursive: true });

  // Update existing file or create new one
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';
  if (content.includes('ANTHROPIC_API_KEY=')) {
    content = content.replace(/ANTHROPIC_API_KEY=.*/, `ANTHROPIC_API_KEY=${trimmed}`);
  } else {
    content = `ANTHROPIC_API_KEY=${trimmed}\n` + content;
  }
  writeFileSync(ENV_PATH, content, 'utf-8');

  // Reload env
  dotenv.config({ path: ENV_PATH, override: true });

  process.stdout.write(`\n  ${green('✓')} saved. Starting agent-os…\n\n`);
  iface.close();
}

// ─── Bootstrap spinner ────────────────────────────────────────────────────────

const ESC = '\x1b';
const clearLine = `\r${ESC}[2K`;
const grayFn = (s: string): string => `${ESC}[90m${s}${ESC}[0m`;
const dimFn  = (s: string): string => `${ESC}[2m${s}${ESC}[0m`;
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinFrame = 0;
let spinTimer: ReturnType<typeof setInterval> | null = null;

function startSpin(label: string): void {
  if (!process.stdout.isTTY) return;
  spinTimer = setInterval(() => {
    const f = SPIN_FRAMES[spinFrame % SPIN_FRAMES.length] ?? '⠋';
    process.stdout.write(`${clearLine}${grayFn(f)} ${dimFn(label)}`);
    spinFrame++;
  }, 80);
}

function stopSpin(): void {
  if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
  if (process.stdout.isTTY) process.stdout.write(clearLine);
}

// ─── Banner ───────────────────────────────────────────────────────────────────

const LOGO = `   ▗▄▖  ▗▄▄▖  ▗▄▄▖
  ▐▌ ▐▌▐▌   ▐▌
  ▐▛▀▜▌▐▌▝▜▌ ▝▀▚▖
  ▐▌ ▐▌▝▚▄▞▘▗▄▄▞▘`;

function printBanner(opts: {
  projectName: string; model: string; skillCount: number; memoryCount: number;
}): void {
  if (!process.stdout.isTTY) return;
  const { projectName, model, skillCount, memoryCount } = opts;
  const E = '\x1b';
  const reset   = `${E}[0m`;
  const dim     = (s: string) => `${E}[2m${s}${reset}`;
  const bold    = (s: string) => `${E}[1m${s}${reset}`;
  const cyan    = (s: string) => `${E}[36m${s}${reset}`;
  const magenta = (s: string) => `${E}[35m${s}${reset}`;
  const white   = (s: string) => `${E}[97m${s}${reset}`;
  const green   = (s: string) => `${E}[32m${s}${reset}`;
  const yellow  = (s: string) => `${E}[33m${s}${reset}`;
  const cwdShort = process.cwd().replace(homedir(), '~');

  let gitLine = '';
  try {
    const branch = execSync('git branch --show-current 2>/dev/null', {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (branch) {
      const dirty = execSync('git status --porcelain 2>/dev/null', {
        encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim().length > 0;
      gitLine = `    ${dim('git')}  ${dirty ? yellow(branch + '*') : green(branch)}`;
    }
  } catch { /* not a git repo */ }

  const out = [
    '',
    ...LOGO.split('\n').map((l) => `  ${magenta(l)}`),
    '',
    `  ${dim('project')}  ${bold(white(projectName))}    ${dim('cwd')}  ${dim(cwdShort)}`,
    `  ${dim('model')}    ${cyan(model)}${gitLine}    ${dim('skills')}  ${dim(String(skillCount))}    ${dim('memory')}  ${dim(memoryCount + ' topics')}`,
    `  ${dim('─'.repeat(52))}`,
    `  ${dim('type a message, or ')}${cyan('/help')}${dim(' · ')}${cyan('/skillname')}${dim(' to invoke a skill')}`,
    '',
  ].join('\n');

  process.stdout.write(out + '\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  process.env['LOG_LEVEL'] = 'warn';

  let config;
  try {
    config = loadConfig(process.env);
  } catch {
    // Key missing → interactive setup, then retry once
    await firstRunSetup();
    try {
      config = loadConfig(process.env);
    } catch (err2: unknown) {
      const msg = err2 instanceof Error ? err2.message : String(err2);
      process.stderr.write(`\nConfiguration error: ${msg}\n\n`);
      process.exit(1);
    }
  }

  if (args.model && ['claude', 'gemini', 'auto'].includes(args.model)) {
    config = { ...config, DEFAULT_MODEL: args.model as typeof config.DEFAULT_MODEL };
  }

  startSpin('loading agent-os…');

  let bootstrapped;
  try {
    bootstrapped = await bootstrap(config);
  } catch (err: unknown) {
    stopSpin();
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\nBootstrap error: ${msg}\n\n`);
    process.exit(1);
  }

  stopSpin();

  const { engine, skills, memory, tools, hamStore, hamCompressor, agents } = bootstrapped;
  const channelId = process.pid.toString();

  const skillCount  = skills.getSkillNames().length;
  const memoryCount = hamStore.getAllL0().length;
  const projectName = process.cwd().split('/').pop() ?? '';
  const model       = args.model ?? config.DEFAULT_MODEL;

  // Print banner to stdout BEFORE Ink takes over — this way it stays at the
  // top of the scrollback and is never overwritten by Ink's dynamic content.
  printBanner({ projectName, model, skillCount, memoryCount });

  const shutdown = (): void => {
    memory.close();
    hamStore.close();
    tools.disconnectAll();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);

  const { waitUntilExit } = render(
    React.createElement(App, {
      engine,
      skills,
      channelId,
      hamStore,
      hamCompressor,
      agents,
      model,
    }),
    { exitOnCtrlC: false },
  );

  await waitUntilExit();
  shutdown();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal error: ${msg}\n`);
  process.exit(1);
});
