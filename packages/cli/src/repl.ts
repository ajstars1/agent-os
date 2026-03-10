import * as readline from 'node:readline/promises';
import type { AgentEngine, SkillLoader, TieredStore, HAMCompressor } from '@agent-os/core';
import type { LLMProvider } from '@agent-os/shared';
import { isCommand, handleCommand, type CommandContext } from './commands/index.js';

// ANSI helpers
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const PROMPT = `${cyan('❯')} `;

const PROVIDER_COLOR: Record<string, (s: string) => string> = {
  claude: cyan,
  gemini: green,
};

export class Repl {
  private readonly rl: readline.Interface;
  private readonly currentModel = { value: 'auto' };
  private conversationId: string;

  constructor(
    private readonly engine: AgentEngine,
    private readonly skills: SkillLoader,
    channelId: string,
    private readonly hamStore?: TieredStore,
    private readonly hamCompressor?: HAMCompressor | null,
  ) {
    const conv = engine.getOrCreateConversation('cli', channelId);
    this.conversationId = conv.id;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    this.rl.on('SIGINT', () => {
      process.stdout.write('\n' + dim('Goodbye.') + '\n');
      this.rl.close();
      process.exit(0);
    });
  }

  async run(): Promise<void> {
    process.stdout.write('\n');
    process.stdout.write(bold('  AgentOS') + dim('  ·  type /help for commands') + '\n');
    process.stdout.write(dim('  ─────────────────────────────────\n'));
    process.stdout.write('\n');

    while (true) {
      let input: string;
      try {
        input = await this.rl.question(PROMPT);
      } catch {
        break;
      }

      const trimmed = input.trim();
      if (!trimmed) continue;

      if (isCommand(trimmed)) {
        const ctx: CommandContext = {
          engine: this.engine,
          skills: this.skills,
          conversationId: this.conversationId,
          currentModel: this.currentModel,
          hamStore: this.hamStore,
          hamCompressor: this.hamCompressor,
        };
        await handleCommand(trimmed, ctx);
        continue;
      }

      await this.chat(trimmed);
    }
  }

  private async chat(message: string): Promise<void> {
    const forceModel = this.currentModel.value !== 'auto'
      ? (this.currentModel.value as LLMProvider)
      : undefined;

    let inputTokens = 0;
    let outputTokens = 0;
    let provider = 'claude';
    let hasOutput = false;

    process.stdout.write('\n');

    try {
      for await (const chunk of this.engine.chat({
        conversationId: this.conversationId,
        message,
        forceModel,
      })) {
        if (chunk.type === 'provider' && chunk.provider) {
          provider = chunk.provider;
        } else if (chunk.type === 'text' && chunk.content) {
          process.stdout.write(chunk.content);
          hasOutput = true;
        } else if (chunk.type === 'usage' && chunk.usage) {
          inputTokens = chunk.usage.inputTokens;
          outputTokens = chunk.usage.outputTokens;
        } else if (chunk.type === 'memory_saved' && chunk.content) {
          process.stdout.write(
            `\n${dim(`  ◆ learned "${chunk.content}" → saved to memory`)}`,
          );
        } else if (chunk.type === 'tool_call' && chunk.toolCall) {
          process.stdout.write(
            `\n${dim(`  ⚙ ${chunk.toolCall.name}`)}\n`,
          );
        } else if (chunk.type === 'done') {
          break;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`\n${red(`  ✗ ${msg}`)}\n\n`);
      return;
    }

    if (hasOutput) {
      const colorFn = PROVIDER_COLOR[provider] ?? yellow;
      const total = inputTokens + outputTokens;
      const tokenInfo = total > 0
        ? dim(` · ${inputTokens}↑ ${outputTokens}↓ tokens`)
        : '';
      process.stdout.write(
        `\n\n${dim('  ─')} ${colorFn(provider)}${tokenInfo}\n\n`,
      );
    }
  }
}
