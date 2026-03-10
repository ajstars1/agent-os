import * as readline from 'node:readline/promises';
import type { AgentEngine, SkillLoader, TieredStore, HAMCompressor } from '@agent-os/core';
import type { LLMProvider } from '@agent-os/shared';
import { isCommand, handleCommand, type CommandContext } from './commands/index.js';

const PROMPT = '\x1b[36m>\x1b[0m ';

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
      process.stdout.write('\nGoodbye.\n');
      this.rl.close();
      process.exit(0);
    });
  }

  async run(): Promise<void> {
    process.stdout.write('\x1b[1mAgentOS\x1b[0m — type /help for commands\n\n');

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
    let usedModel = 'claude';
    let hasOutput = false;

    try {
      for await (const chunk of this.engine.chat({
        conversationId: this.conversationId,
        message,
        forceModel,
      })) {
        if (chunk.type === 'text' && chunk.content) {
          process.stdout.write(chunk.content);
          hasOutput = true;
        } else if (chunk.type === 'usage' && chunk.usage) {
          inputTokens = chunk.usage.inputTokens;
          outputTokens = chunk.usage.outputTokens;
        } else if (chunk.type === 'tool_call' && chunk.toolCall) {
          process.stdout.write(
            `\n\x1b[2m[calling tool: ${chunk.toolCall.name}]\x1b[0m\n`,
          );
        } else if (chunk.type === 'done') {
          break;
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`\n\x1b[31mError: ${message}\x1b[0m\n`);
      return;
    }

    if (hasOutput) {
      process.stdout.write(
        `\n\n\x1b[2m[model: ${usedModel} | in: ${inputTokens} out: ${outputTokens} tokens]\x1b[0m\n`,
      );
    }
  }
}
