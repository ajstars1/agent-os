import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentEngine, SkillLoader, TieredStore, HAMCompressor, AgentLoader } from '@agent-os/core';
import type { Message } from '@agent-os/shared';

export interface CommandContext {
  engine: AgentEngine;
  skills: SkillLoader;
  conversationId: string;
  currentModel: { value: string };
  hamStore?: TieredStore;
  hamCompressor?: HAMCompressor | null;
  agents?: AgentLoader;
}

const ENV_PATH = join(homedir(), '.agent-os', '.env');

const HELP_TEXT = `Available commands:
  /help                           Show this help message
  /clear                          Clear conversation history
  /model <claude|gemini|auto>     Switch model (gemini:flash|pro|flash-thinking|pro-thinking)
  /config                         Show all config keys and values
  /config set <KEY> <value>       Update a config key in ~/.agent-os/.env
  /config path                    Show config file path
  /skills                         List loaded skills
  /memory list                    Show all memory topics
  /memory stats                   Show memory access patterns
  /memory add <topic> <content>   Store knowledge
  /export [filename]              Export conversation to markdown
  /cd <path>                      Change working directory
  /cwd                            Print current working directory
  /dream                          Run memory consolidation cycle
  /agents                         List agent profiles
  /exit                           Exit agent-os`;

const SECRET_KEYS = new Set(['ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'DISCORD_TOKEN']);

function maskSecret(key: string, value: string): string {
  if (!SECRET_KEYS.has(key) || !value) return value;
  if (value.length <= 8) return '••••••••';
  return value.slice(0, 6) + '••••' + value.slice(-4);
}

function readEnvFile(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const lines = readFileSync(ENV_PATH, 'utf-8').split('\n');
  const result: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    result[key] = val;
  }
  return result;
}

function writeEnvKey(key: string, value: string): void {
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';
  const pattern = new RegExp(`^${key}=.*`, 'm');
  if (pattern.test(content)) {
    content = content.replace(pattern, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  writeFileSync(ENV_PATH, content, 'utf-8');
  // Hot-reload into current process
  process.env[key] = value;
}

export const commands: Record<
  string,
  (args: string, ctx: CommandContext) => string | Promise<string>
> = {
  help: () => HELP_TEXT,

  clear: (_args, ctx) => {
    ctx.engine.clearConversation(ctx.conversationId);
    return 'Conversation cleared.';
  },

  model: (args, ctx) => {
    const model = args.trim();
    const valid = ['claude', 'gemini', 'auto', 'gemini:flash', 'gemini:pro', 'gemini:flash-thinking', 'gemini:pro-thinking'];
    if (!valid.includes(model)) {
      return `Invalid model. Choose:\n  claude | gemini | auto\n  gemini:flash | gemini:pro | gemini:flash-thinking | gemini:pro-thinking`;
    }
    ctx.currentModel.value = model;
    const labels: Record<string, string> = {
      'gemini:flash': 'Gemini 2.0 Flash',
      'gemini:pro': 'Gemini 1.5 Pro',
      'gemini:flash-thinking': 'Gemini Flash Thinking (budget: 8k tokens)',
      'gemini:pro-thinking': 'Gemini 2.5 Pro + Thinking (budget: 16k tokens)',
    };
    return `Model set to: ${labels[model] ?? model}`;
  },

  config: (args) => {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0] ?? '';

    if (sub === 'path') {
      return `Config file: ${ENV_PATH}`;
    }

    if (sub === 'set') {
      const key = parts[1];
      const value = parts.slice(2).join(' ');
      if (!key || !value) {
        return 'Usage: /config set <KEY> <value>\nExample: /config set ANTHROPIC_API_KEY sk-ant-...';
      }
      writeEnvKey(key, value);
      return `Set ${key} = ${maskSecret(key, value)}`;
    }

    // Default: show all config
    const env = readEnvFile();
    const knownKeys = [
      'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY',
      'DEFAULT_MODEL', 'DB_PATH', 'SKILLS_DIR', 'CLAUDE_MD_PATH',
      'NEURAL_ENGINE_URL', 'WEB_PORT', 'WEB_CORS_ORIGIN', 'AGENTS_DIR',
      'DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID',
      'LOG_LEVEL', 'NODE_ENV',
    ];

    const lines: string[] = [`Config  (${ENV_PATH})\n`];
    for (const key of knownKeys) {
      const val = env[key] ?? process.env[key] ?? '';
      const display = val ? maskSecret(key, val) : '(not set)';
      const set = val ? '' : '  ← missing';
      lines.push(`  ${key.padEnd(26)} ${display}${set}`);
    }

    // Also show any unknown keys from the file
    const extra = Object.keys(env).filter((k) => !knownKeys.includes(k));
    if (extra.length > 0) {
      lines.push('\n  Other:');
      for (const k of extra) {
        lines.push(`  ${k.padEnd(26)} ${maskSecret(k, env[k] ?? '')}`);
      }
    }

    lines.push('\nUse /config set <KEY> <value> to update any key.');
    return lines.join('\n');
  },

  skills: (_args, ctx) => {
    const context = ctx.skills.getSystemContext();
    const lines = context.split('\n').filter((l) => l.startsWith('# Skill:'));
    if (lines.length === 0) return 'No skills loaded.';
    return 'Loaded skills:\n' + lines.map((l) => `  • ${l.replace('# Skill: ', '')}`).join('\n');
  },

  memory: async (args, ctx) => {
    const [subCmd, ...rest] = args.trim().split(/\s+/);

    if (subCmd === 'list') {
      if (!ctx.hamStore) return 'HAM memory not available.';
      const entries = ctx.hamStore.getAllL0();
      if (entries.length === 0) return 'No knowledge stored yet. Use /memory add <topic> <content>';
      const lines = entries.map((e) => `  ${e.topic} — ${e.l0}`);
      return `Knowledge base (${entries.length} topics):\n${lines.join('\n')}`;
    }

    if (subCmd === 'stats') {
      if (!ctx.hamStore) return 'HAM memory not available.';
      const stats = ctx.hamStore.getAllChunkStats();
      if (stats.length === 0) return 'No knowledge stored yet.';
      const totalL0Tokens = stats.reduce((acc, s) => acc + Math.ceil(s.l0.length / 4), 0);
      const header = `HAM Memory — ${stats.length} topics, ~${totalL0Tokens} L0 tokens\n${'─'.repeat(50)}`;
      const rows = stats.map((s) => {
        const lastDate = s.lastAccessed
          ? new Date(s.lastAccessed).toLocaleDateString()
          : 'never';
        return `  ${s.topic.slice(0, 20).padEnd(20)} ${String(s.accessCount).padEnd(8)} ${lastDate}`;
      });
      return `${header}\n  ${'Topic'.padEnd(20)} ${'Accesses'.padEnd(8)} Last Accessed\n${rows.join('\n')}`;
    }

    if (subCmd === 'add') {
      if (!ctx.hamStore || !ctx.hamCompressor) {
        return ctx.hamStore
          ? 'GOOGLE_API_KEY required for compression. Set it in .env'
          : 'HAM memory not available.';
      }
      const topic = rest[0];
      const content = rest.slice(1).join(' ');
      if (!topic || !content) return 'Usage: /memory add <topic> <content>';
      try {
        const compressed = await ctx.hamCompressor.compressChunk(content, topic);
        ctx.hamStore.addChunk({ ...compressed, lastAccessed: Date.now(), accessCount: 0 });
        return `Stored: ${topic} — ${compressed.L0}`;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Error: ${msg}`;
      }
    }

    return 'Usage: /memory [list|stats|add <topic> <content>]';
  },

  export: (_args, ctx) => {
    const messages = ctx.engine.getMessages(ctx.conversationId);
    if (messages.length === 0) return 'No messages to export.';

    const markdown = formatConversationMarkdown(messages);
    const filename = _args.trim() || generateExportFilename();
    const filepath = resolve(process.cwd(), filename);

    try {
      writeFileSync(filepath, markdown, 'utf-8');
      return `Conversation exported to ${filepath}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: ${msg}`;
    }
  },

  cd: (args) => {
    const rawPath = args.trim();
    if (!rawPath) return process.cwd();
    let target = rawPath.startsWith('~') ? rawPath.replace('~', homedir()) : rawPath;
    if (!isAbsolute(target)) target = resolve(process.cwd(), target);
    try {
      process.chdir(target);
      return `cwd: ${process.cwd()}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: ${msg}`;
    }
  },

  cwd: () => process.cwd(),

  dream: (_args, ctx) => {
    try {
      ctx.engine.startSleepCycle();
      return 'Sleep cycle started — memory consolidation in progress.';
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: ${msg}`;
    }
  },

  agents: (_args, ctx) => {
    if (!ctx.agents) return 'Agent loader not available.';
    const profiles = ctx.agents.list();
    if (profiles.length === 0) return 'No agent profiles loaded.';
    const lines = profiles.map((p) => {
      const desc = 'description' in p && typeof p.description === 'string' ? ` — ${p.description}` : '';
      return `  • ${p.name}${desc}`;
    });
    return `Agent profiles (${profiles.length}):\n${lines.join('\n')}`;
  },

  exit: () => {
    process.exit(0);
    return ''; // unreachable, satisfies type
  },
};

function generateExportFilename(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `agent-os-export-${date}-${time}.md`;
}

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

export async function handleCommand(input: string, ctx: CommandContext): Promise<string> {
  const [cmd, ...rest] = input.slice(1).split(' ');
  const handler = commands[cmd ?? ''];
  if (!handler) {
    return `Unknown command: /${cmd}. Type /help for a list.`;
  }
  return handler(rest.join(' '), ctx);
}
