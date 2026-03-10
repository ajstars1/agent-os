import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentEngine, SkillLoader, TieredStore, HAMCompressor } from '@agent-os/core';
import type { Message } from '@agent-os/shared';

export interface CommandContext {
  engine: AgentEngine;
  skills: SkillLoader;
  conversationId: string;
  currentModel: { value: string };
  hamStore?: TieredStore;
  hamCompressor?: HAMCompressor | null;
}

const HELP_TEXT = `
Available commands:
  /help                      Show this help message
  /clear                     Clear conversation history
  /model <name>              Switch model (claude | gemini | auto)
  /skills                    List loaded skills
  /memory list               Show all topics with L0 headlines
  /memory stats              Show token usage and access patterns
  /memory add <topic> <content>  Compress and store knowledge
  /export [filename]         Export conversation to markdown file
  /exit                      Exit the agent
`;

export const commands: Record<
  string,
  (args: string, ctx: CommandContext) => void | Promise<void>
> = {
  help: (_args, _ctx) => {
    process.stdout.write(HELP_TEXT + '\n');
  },

  clear: (_args, ctx) => {
    ctx.engine.clearConversation(ctx.conversationId);
    process.stdout.write('\x1b[2m[Conversation cleared]\x1b[0m\n');
  },

  model: (args, ctx) => {
    const model = args.trim();
    if (!['claude', 'gemini', 'auto'].includes(model)) {
      process.stdout.write(`Invalid model. Choose: claude | gemini | auto\n`);
      return;
    }
    ctx.currentModel.value = model;
    process.stdout.write(`\x1b[2m[Model set to: ${model}]\x1b[0m\n`);
  },

  skills: (_args, ctx) => {
    const context = ctx.skills.getSystemContext();
    const lines = context.split('\n').filter((l) => l.startsWith('# Skill:'));
    if (lines.length === 0) {
      process.stdout.write('No skills loaded.\n');
      return;
    }
    process.stdout.write('Loaded skills:\n');
    for (const line of lines) {
      process.stdout.write(`  • ${line.replace('# Skill: ', '')}\n`);
    }
  },

  memory: async (args, ctx) => {
    const [subCmd, ...rest] = args.trim().split(/\s+/);

    if (subCmd === 'list') {
      if (!ctx.hamStore) {
        process.stdout.write('HAM memory not available.\n');
        return;
      }
      const entries = ctx.hamStore.getAllL0();
      if (entries.length === 0) {
        process.stdout.write('No knowledge stored yet. Use /memory add <topic> <content>\n');
        return;
      }
      process.stdout.write(`\nKnowledge base (${entries.length} topics):\n`);
      for (const e of entries) {
        process.stdout.write(`  \x1b[36m${e.topic}\x1b[0m — ${e.l0}\n`);
      }
      process.stdout.write('\n');
      return;
    }

    if (subCmd === 'stats') {
      if (!ctx.hamStore) {
        process.stdout.write('HAM memory not available.\n');
        return;
      }
      const stats = ctx.hamStore.getAllChunkStats();
      if (stats.length === 0) {
        process.stdout.write('No knowledge stored yet.\n');
        return;
      }
      const totalL0Tokens = stats.reduce((acc, s) => acc + Math.ceil(s.l0.length / 4), 0);
      process.stdout.write(`\nHAM Memory Stats — ${stats.length} topics, ~${totalL0Tokens} L0 tokens\n`);
      process.stdout.write(`${'Topic'.padEnd(20)} ${'Accesses'.padEnd(10)} Last Accessed\n`);
      process.stdout.write('─'.repeat(55) + '\n');
      for (const s of stats) {
        const lastDate = s.lastAccessed
          ? new Date(s.lastAccessed).toLocaleDateString()
          : 'never';
        process.stdout.write(
          `${s.topic.slice(0, 19).padEnd(20)} ${String(s.accessCount).padEnd(10)} ${lastDate}\n`,
        );
      }
      process.stdout.write('\n');
      return;
    }

    if (subCmd === 'add') {
      if (!ctx.hamStore || !ctx.hamCompressor) {
        process.stdout.write(
          ctx.hamStore
            ? 'GOOGLE_API_KEY required for compression. Set it in .env\n'
            : 'HAM memory not available.\n',
        );
        return;
      }
      // Format: /memory add <topic> <...content>
      const topic = rest[0];
      const content = rest.slice(1).join(' ');
      if (!topic || !content) {
        process.stdout.write('Usage: /memory add <topic> <content>\n');
        return;
      }
      process.stdout.write(`\x1b[2mCompressing "${topic}"...\x1b[0m\n`);
      try {
        const compressed = await ctx.hamCompressor.compressChunk(content, topic);
        ctx.hamStore.addChunk({ ...compressed, lastAccessed: Date.now(), accessCount: 0 });
        process.stdout.write(`\x1b[32m✓\x1b[0m Stored: \x1b[36m${topic}\x1b[0m — ${compressed.L0}\n`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(`\x1b[31mError:\x1b[0m ${msg}\n`);
      }
      return;
    }

    process.stdout.write('Usage: /memory [list|stats|add <topic> <content>]\n');
  },

  export: (_args, ctx) => {
    const messages = ctx.engine.getMessages(ctx.conversationId);
    if (messages.length === 0) {
      process.stdout.write('No messages to export.\n');
      return;
    }

    const markdown = formatConversationMarkdown(messages);
    const filename = _args.trim() || generateExportFilename();
    const filepath = resolve(process.cwd(), filename);

    try {
      writeFileSync(filepath, markdown, 'utf-8');
      process.stdout.write(`\x1b[32m✓\x1b[0m Conversation exported to ${filepath}\n`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`\x1b[31mError:\x1b[0m ${msg}\n`);
    }
  },

  exit: (_args, _ctx) => {
    process.stdout.write('Goodbye.\n');
    process.exit(0);
  },
};

/**
 * Generates a timestamped filename for conversation exports.
 *
 * @returns A string in the format `agent-os-export-YYYYMMDD-HHmmss.md`.
 */
function generateExportFilename(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `agent-os-export-${date}-${time}.md`;
}

/**
 * Converts an array of conversation messages into a formatted markdown string.
 *
 * @param messages - Array of Message objects from the conversation history.
 * @returns A markdown-formatted string containing the full conversation.
 */
function formatConversationMarkdown(messages: Message[]): string {
  const lines: string[] = [];
  const exportDate = new Date().toISOString();

  lines.push('# AgentOS Conversation Export');
  lines.push('');
  lines.push(`**Exported:** ${exportDate}`);
  lines.push(`**Messages:** ${messages.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const timestamp = msg.createdAt
      ? new Date(msg.createdAt).toLocaleString()
      : 'unknown';
    const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
    const modelTag = msg.model ? ` *(${msg.model})*` : '';

    lines.push(`### ${roleLabel}${modelTag}`);
    lines.push(`> ${timestamp}`);
    lines.push('');
    lines.push(msg.content);
    lines.push('');
  }

  return lines.join('\n');
}

export function isCommand(input: string): boolean {
  return input.startsWith('/');
}

export async function handleCommand(input: string, ctx: CommandContext): Promise<void> {
  const [cmd, ...rest] = input.slice(1).split(' ');
  const handler = commands[cmd ?? ''];
  if (!handler) {
    process.stdout.write(`Unknown command: /${cmd}. Type /help for a list.\n`);
    return;
  }
  await handler(rest.join(' '), ctx);
}
