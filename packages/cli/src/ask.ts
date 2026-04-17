#!/usr/bin/env node
/**
 * ask — one-shot terminal Q&A powered by the full AgentOS engine.
 *
 * Everything goes through the same core: companion memory, HAM retrieval,
 * orchestrator (specialist agents for complex requests), profile extraction.
 * ask is an adapter, not a bypass.
 *
 * Usage:
 *   ask "how to check ubuntu version?"         # auto-route (Gemini default)
 *   ask --claude "explain closures"            # force Claude
 *   ask --verbose "build a REST API with auth" # suppress concise system prompt
 *   ask --agents "research + build X"          # force multi-agent mode
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// ── Env resolution (same as main CLI) ────────────────────────────────────────
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
  dotenv.config({ path: join(scriptDir, '../../../.env'), override: false });
}
resolveEnv();

import { bootstrap } from '@agent-os-core/core';
import { loadConfig } from '@agent-os-core/shared';
import { renderMarkdown } from './ui/markdown.js';

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const ESC = '\x1b';
const dim  = (s: string) => `${ESC}[2m${s}${ESC}[0m`;
const bold = (s: string) => `${ESC}[1m${s}${ESC}[0m`;

// ── Spinner ───────────────────────────────────────────────────────────────────
const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'] as const;

function createSpinner() {
  let label = 'thinking...';
  let i = 0;
  process.stdout.write('\n');
  const id = setInterval(() => {
    process.stdout.write(`\r  ${dim(FRAMES[i++ % FRAMES.length] ?? '⠋')}  ${dim(label)}`);
  }, 80);
  return {
    update(newLabel: string) { label = newLabel; },
    stop() {
      clearInterval(id);
      process.stdout.write('\r\x1b[2K');
    },
  };
}

// ── Arg parsing ───────────────────────────────────────────────────────────────
interface AskArgs {
  forceProvider: 'claude' | undefined;
  verbose: boolean;
  question: string;
}

function parseArgs(argv: string[]): AskArgs {
  const args = argv.slice(2);
  let forceProvider: 'claude' | undefined;
  let verbose = false;
  const parts: string[] = [];
  for (const a of args) {
    if (a === '--claude' || a === '-c') forceProvider = 'claude';
    else if (a === '--verbose' || a === '-v') verbose = true;
    else parts.push(a);
  }
  return { forceProvider, verbose, question: parts.join(' ').trim() };
}

// ── Concise system prompt override for ask context ────────────────────────────
const CONCISE_OVERRIDE =
  'Terminal mode: be direct and concise.\n' +
  '- Simple questions: 1-4 lines max. Show the exact command or answer first.\n' +
  '- Only use code blocks for actual code/commands.\n' +
  '- No lengthy preambles, no "Method 1/2/3" sections unless explicitly asked.\n' +
  '- For "explain / how does / why" questions you may elaborate.';

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // `ask --status` is an alias for `agent-status` — handle before bootstrap
  // so it works even without a valid Claude API key.
  if (process.argv.includes('--status') || process.argv.includes('-s')) {
    const { main: statusMain } = await import('./status.js');
    await statusMain();
    return;
  }

  const { forceProvider, verbose, question } = parseArgs(process.argv);

  if (!question) {
    process.stderr.write('Usage: ask [--claude] [--verbose] "<question>"\n');
    process.stderr.write('       ask --status               (engine status)\n');
    process.exit(1);
  }

  // ── Bootstrap full AgentOS engine ─────────────────────────────────────────
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`Config error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write('Run `agent` once to set up your API keys.\n');
    process.exit(1);
  }

  // Silence engine logs in ask mode (clean terminal output)
  config = { ...config, LOG_LEVEL: 'error' as const };

  const { engine, skills } = await bootstrap(config);

  // Use a stable daily conversation ID for ask — this lets memory accumulate
  // across ask sessions within the same day, but doesn't pollute chat history.
  const today = new Date().toISOString().slice(0, 10);
  const conversationId = `ask-${today}`;

  const providerTag = forceProvider === 'claude'
    ? dim('[claude]')
    : dim('[agent-os]');

  process.stdout.write(`${providerTag} ${bold(question)}`);

  const spinner = createSpinner();

  // Build the message — optionally prepend concise override
  const message = verbose ? question : `${CONCISE_OVERRIDE}\n\n${question}`;

  let fullAnswer = '';

  try {
    for await (const chunk of engine.chat({
      conversationId,
      message,
      forceModel: forceProvider,
      // Enable Google Search grounding when using Gemini (default in ask)
      useSearch: forceProvider !== 'claude' && !!config.GOOGLE_API_KEY,
    })) {
      if (chunk.type === 'status' && chunk.content) {
        // Orchestrator progress — show on spinner only, never in output
        spinner.update(chunk.content);
      } else if (chunk.type === 'text' && chunk.content) {
        fullAnswer += chunk.content;
      }
      // Ignore provider, tool_call, tool_result, memory_saved, done, thinking chunks
    }

    spinner.stop();

    const answer = fullAnswer.trim();
    if (answer) {
      process.stdout.write('\n');
      process.stdout.write(renderMarkdown(answer));
      process.stdout.write('\n');
    } else {
      process.stdout.write('\n[No response]\n');
    }

    process.stdout.write('\n');
  } catch (e) {
    spinner.stop();
    process.stderr.write(`\nError: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  } finally {
    // Stop file watchers / timers so the process can exit cleanly
    engine.cancelIdleTimer();
    skills.stopWatching();
  }
}

main();
