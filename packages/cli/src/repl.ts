import * as readline from 'node:readline/promises';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentEngine, SkillLoader, TieredStore, HAMCompressor, AgentLoader } from '@agent-os-core/core';
import type { LLMProvider } from '@agent-os-core/shared';
import { isCommand, handleCommand, type CommandContext } from './commands/index.js';

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const E = '\x1b';
const reset  = `${E}[0m`;
const dim    = (s: string) => `${E}[2m${s}${reset}`;
const bold   = (s: string) => `${E}[1m${s}${reset}`;
const cyan   = (s: string) => `${E}[36m${s}${reset}`;
const green  = (s: string) => `${E}[32m${s}${reset}`;
const yellow = (s: string) => `${E}[33m${s}${reset}`;
const red    = (s: string) => `${E}[31m${s}${reset}`;
const gray   = (s: string) => `${E}[90m${s}${reset}`;
const blue   = (s: string) => `${E}[38;5;75m${s}${reset}`;
const violet = (s: string) => `${E}[38;5;141m${s}${reset}`;
const teal   = (s: string) => `${E}[38;5;38m${s}${reset}`;
const white  = (s: string) => `${E}[97m${s}${reset}`;
const clearLine = `\r${E}[2K`;
const moveUp    = (n: number) => `${E}[${n}A`;
const cursorCol = (n: number) => `${E}[${n}G`;

const PROVIDER_COLOR: Record<string, (s: string) => string> = {
  claude: cyan,
  gemini: green,
};

// ─── Tool icons ───────────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  bash:      '❯',
  glob:      '◈',
  grep:      '⌕',
  edit:      '✎',
  read_file: '◎',
  write_file:'◉',
  ls:        '▤',
  web_fetch: '⇲',
  remember:  '◆',
};

function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? '⚙';
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private label = '';

  start(label: string): void {
    this.label = label;
    if (!process.stdout.isTTY) return;
    this.timer = setInterval(() => {
      const f = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length] ?? '⠋';
      process.stdout.write(`${clearLine}  ${cyan(f)} ${dim(this.label)}`);
      this.frame++;
    }, 80);
  }

  update(label: string): void {
    this.label = label;
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (process.stdout.isTTY) process.stdout.write(clearLine);
  }
}

// ─── History ──────────────────────────────────────────────────────────────────

const HISTORY_FILE = join(homedir(), '.agent-os', 'history');
const HISTORY_MAX  = 500;

function saveHistory(lines: string[]): void {
  try {
    mkdirSync(join(homedir(), '.agent-os'), { recursive: true });
    const ws = createWriteStream(HISTORY_FILE, { flags: 'w' });
    ws.write(lines.slice(-HISTORY_MAX).join('\n') + '\n');
    ws.end();
  } catch { /* non-fatal */ }
}

// ─── Welcome banner ───────────────────────────────────────────────────────────

const LOGO = `   ▗▄▖  ▗▄▄▖  ▗▄▄▖
  ▐▌ ▐▌▐▌   ▐▌
  ▐▛▀▜▌▐▌▝▜▌ ▝▀▚▖
  ▐▌ ▐▌▝▚▄▞▘▗▄▄▞▘`;

function welcomeBanner(opts: {
  cwd: string; model: string; skillCount: number;
  memoryCount: number; projectName: string;
}): string {
  const { cwd, model, skillCount, memoryCount, projectName } = opts;
  const cwdShort = cwd.replace(homedir(), '~');
  const cols = process.stdout.columns || 72;
  const bar = dim('─'.repeat(Math.min(cols - 2, 54)));

  const logoColored = LOGO
    .split('\n')
    .map((l) => `  ${violet(l)}`)
    .join('\n');

  const meta = [
    `  ${gray('project')}  ${white(projectName)}    ${gray('cwd')}  ${dim(cwdShort)}`,
    `  ${gray('model')}    ${cyan(model)}    ${gray('skills')}  ${dim(String(skillCount))}    ${gray('memory')}  ${dim(String(memoryCount) + ' topics')}`,
  ].join('\n');

  return [
    '',
    logoColored,
    '',
    meta,
    `  ${bar}`,
    '',
  ].join('\n');
}

// ─── REPL ─────────────────────────────────────────────────────────────────────

export class Repl {
  private readonly rl: readline.Interface;
  private readonly currentModel = { value: 'auto' };
  private conversationId: string;
  private abortController: AbortController | null = null;
  private readonly spinner = new Spinner();
  private readonly history: string[] = [];

  constructor(
    private readonly engine: AgentEngine,
    private readonly skills: SkillLoader,
    channelId: string,
    private readonly hamStore?: TieredStore,
    private readonly hamCompressor?: HAMCompressor | null,
    private readonly agents?: AgentLoader,
  ) {
    const conv = engine.getOrCreateConversation('cli', channelId);
    this.conversationId = conv.id;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: HISTORY_MAX,
    });

    // Ctrl+C: cancel stream if active, otherwise exit
    this.rl.on('SIGINT', () => {
      if (this.abortController) {
        this.abortController.abort();
        this.spinner.stop();
        process.stdout.write(`\n\n  ${dim('↩ cancelled')}\n\n`);
      } else {
        saveHistory(this.history);
        process.stdout.write(`\n  ${dim('bye.')}\n\n`);
        this.rl.close();
        process.exit(0);
      }
    });
  }

  async run(opts?: {
    model: string; skillCount: number;
    memoryCount: number; projectName: string;
  }): Promise<void> {
    process.stdout.write(welcomeBanner({
      cwd: process.cwd(),
      model:        opts?.model        ?? 'claude',
      skillCount:   opts?.skillCount   ?? 0,
      memoryCount:  opts?.memoryCount  ?? 0,
      projectName:  opts?.projectName  ?? '',
    }));

    const PROMPT = `  ${teal('❯')} `;

    while (true) {
      let input: string;
      try { input = await this.rl.question(PROMPT); }
      catch { break; }

      const trimmed = input.trim();
      if (!trimmed) continue;

      if (this.history[this.history.length - 1] !== trimmed) {
        this.history.push(trimmed);
      }

      if (isCommand(trimmed)) {
        const ctx: CommandContext = {
          engine: this.engine, skills: this.skills,
          conversationId: this.conversationId,
          currentModel: this.currentModel,
          hamStore: this.hamStore, hamCompressor: this.hamCompressor,
          agents: this.agents,
        };
        await handleCommand(trimmed, ctx);
        continue;
      }

      await this.chat(trimmed);
    }

    saveHistory(this.history);
  }

  private async chat(message: string): Promise<void> {
    const forceModel = this.currentModel.value !== 'auto'
      ? (this.currentModel.value as LLMProvider)
      : undefined;

    let inputTokens = 0;
    let outputTokens = 0;
    let provider = 'claude';
    let hasOutput = false;
    let firstToken = false;
    const startMs = Date.now();
    const toolTimings = new Map<string, number>(); // toolCallId → start ms

    this.abortController = new AbortController();
    const { signal } = this.abortController;

    process.stdout.write('\n');
    this.spinner.start('thinking…');

    try {
      for await (const chunk of this.engine.chat({
        conversationId: this.conversationId,
        message,
        forceModel,
      })) {
        if (signal.aborted) break;

        switch (chunk.type) {
          case 'provider':
            if (chunk.provider) {
              provider = chunk.provider;
              this.spinner.update(`${chunk.provider} is thinking…`);
            }
            break;

          case 'status':
            // Orchestrator progress updates — show on spinner only
            if (chunk.content) this.spinner.update(chunk.content);
            break;

          case 'text':
            if (chunk.content) {
              if (!firstToken) { this.spinner.stop(); firstToken = true; }
              process.stdout.write(chunk.content);
              hasOutput = true;
            }
            break;

          case 'tool_call':
            if (chunk.toolCall) {
              if (!firstToken) { this.spinner.stop(); firstToken = true; }
              const { name, id, input } = chunk.toolCall;
              toolTimings.set(id, Date.now());
              const preview = argPreview(input);
              process.stdout.write(
                `\n  ${dim('┌')} ${blue(toolIcon(name))} ${cyan(name)}${preview ? gray(`  ${preview}`) : ''}\n`,
              );
            }
            break;

          case 'tool_result':
            if (chunk.toolResult) {
              const { toolCallId, content, isError } = chunk.toolResult;
              const elapsed = toolTimings.has(toolCallId)
                ? ` ${dim((Date.now() - (toolTimings.get(toolCallId) ?? Date.now())) + 'ms')}`
                : '';
              const resultSnippet = resultPreview(content);
              const icon = isError ? red('✗') : dim('✓');
              process.stdout.write(
                `  ${dim('└')} ${icon}${elapsed}${resultSnippet ? `  ${gray(resultSnippet)}` : ''}\n`,
              );
            }
            break;

          case 'usage':
            if (chunk.usage) {
              inputTokens = chunk.usage.inputTokens;
              outputTokens = chunk.usage.outputTokens;
            }
            break;

          case 'memory_saved':
            if (chunk.content) {
              process.stdout.write(
                `\n  ${teal('◆')} ${dim(`learned "${chunk.content}"`)}\n`,
              );
            }
            break;

          case 'done':
            break;
        }
      }
    } catch (err: unknown) {
      this.spinner.stop();
      if (!signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(`\n\n  ${red('✗')} ${dim(msg)}\n\n`);
      }
      this.abortController = null;
      return;
    }

    this.spinner.stop();
    this.abortController = null;

    if (hasOutput) {
      const colorFn = PROVIDER_COLOR[provider] ?? yellow;
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      const total   = inputTokens + outputTokens;
      const tokens  = total > 0 ? dim(`${inputTokens}↑ ${outputTokens}↓  `) : '';
      const cols    = process.stdout.columns || 72;

      // skill suggestions — TF-IDF, zero tokens, threshold raised to 0.08
      const suggestions = this.skills.recommender.suggest(message, 3, 0.08);

      const leftPart  = `  ${dim('─')} ${colorFn(provider)}  ${tokens}${dim(elapsed + 's')}`;
      const rightPart = suggestions.length > 0
        ? `  ${dim('💡')} ` + suggestions.map((s) => teal('/' + s.name)).join(dim('  '))
        : '';

      process.stdout.write(`\n\n${leftPart}${rightPart}\n\n`);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function argPreview(input: Record<string, unknown>): string {
  const keys = ['path', 'file_path', 'command', 'pattern', 'url', 'query', 'topic', 'old_string'];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string') {
      const t = v.replace(/\n/g, ' ').trim();
      return t.length > 55 ? t.slice(0, 52) + '…' : t;
    }
  }
  for (const [, v] of Object.entries(input)) {
    if (typeof v === 'string') {
      const t = v.replace(/\n/g, ' ').trim();
      return t.length > 55 ? t.slice(0, 52) + '…' : t;
    }
  }
  return '';
}

function resultPreview(content: string): string {
  const first = content.split('\n').find((l) => l.trim().length > 0) ?? '';
  const t = first.trim();
  return t.length > 60 ? t.slice(0, 57) + '…' : t;
}

// suppress unused warnings
void moveUp; void cursorCol; void bold; void yellow; void existsSync; void white;
