import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AgentEngine, SkillLoader, TieredStore, HAMCompressor, AgentLoader, FeedbackStore } from '@agent-os-core/core';
import type { Message } from '@agent-os-core/shared';
import { startConfigServer } from '../config-server.js';

/**
 * Walk up from the compiled CLI's location to find the monorepo root.
 * Returns the path if the running CLI is inside an `agent-os` dev checkout
 * (has root package.json with name "agent-os" and a `packages/` directory).
 * Returns null when running from a published tarball / installed package.
 */
function findDevMonorepoRoot(): string | null {
  try {
    const here = fileURLToPath(import.meta.url);
    let dir = dirname(here);
    for (let i = 0; i < 8; i++) {
      const pkgPath = join(dir, 'package.json');
      if (existsSync(pkgPath) && existsSync(join(dir, 'packages'))) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
          if (pkg.name === 'agent-os') return dir;
        } catch { /* keep walking */ }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fileURLToPath / import.meta.url unavailable
  }
  return null;
}

let _activeConfigServer: { url: string; close: () => void } | null = null;

export interface CommandContext {
  engine: AgentEngine;
  skills: SkillLoader;
  conversationId: string;
  currentModel: { value: string };
  hamStore?: TieredStore;
  hamCompressor?: HAMCompressor | null;
  agents?: AgentLoader;
  feedbackStore?: FeedbackStore;
  /** Last assistant response — used as context when saving feedback */
  lastAssistantMessage?: string;
}

const ENV_PATH = join(homedir(), '.agent-os', '.env');

const HELP_TEXT = `Available commands:
  /help                           Show this help message
  /clear                          Clear conversation history
  /model <claude|gemini|auto>     Switch model (gemini:flash|pro|flash-thinking|pro-thinking)
  /config                         Show all config keys and values
  /config set <KEY> <value>       Update a config key in ~/.agent-os/.env
  /config path                    Show config file path
  /config web                     Launch config web UI (localhost)
  /skills                         List loaded skills
  /memory list                    Show all memory topics
  /memory stats                   Show memory access patterns
  /memory add <topic> <content>   Store knowledge
  /feedback <text>                Save feedback to improve future responses
  /feedback list                  Show saved feedback entries
  /export [filename]              Export conversation to markdown
  /cd <path>                      Change working directory
  /cwd                            Print current working directory
  /dream                          Run memory consolidation cycle
  /agents                         List agent profiles
  /update                         Pull latest code and rebuild
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

  config: async (args) => {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0] ?? '';

    if (sub === 'web') {
      const action = parts[1] ?? '';

      if (action === 'stop') {
        if (_activeConfigServer) {
          _activeConfigServer.close();
          _activeConfigServer = null;
          return 'Config UI stopped.';
        }
        return 'Config UI is not running.';
      }

      if (_activeConfigServer) {
        return `Config UI already running at ${_activeConfigServer.url}`;
      }
      try {
        const port = parseInt(process.env['CONFIG_UI_PORT'] ?? '7877', 10);
        _activeConfigServer = await startConfigServer(port);
        return `Config UI started at ${_activeConfigServer.url}\nOpen in browser — changes sync to terminal in real-time.\nRun /config web stop to shut it down.`;
      } catch (err: unknown) {
        return `Failed to start config server: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

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

  feedback: (args, ctx) => {
    const sub = args.trim();

    if (sub === 'list') {
      if (!ctx.feedbackStore) return 'Feedback store not available.';
      const entries = ctx.feedbackStore.getAll(20);
      if (entries.length === 0) return 'No feedback saved yet. Use /feedback <text> to add.';
      const lines = entries.flatMap((e) => {
        const date = new Date(e.timestamp).toLocaleString();
        const status = e.applied ? '✓' : '○';
        const row = [`  ${status} [${date}] ${e.text}`];
        const lastUser = [...e.history].reverse().find((t) => t.role === 'user');
        if (lastUser) {
          const preview = lastUser.content.replace(/\s+/g, ' ').trim().slice(0, 80);
          row.push(`      ↪ user: "${preview}${lastUser.content.length > 80 ? '…' : ''}"`);
        }
        return row;
      });
      return `Feedback (${entries.length} entries, ✓=applied ○=pending):\n${lines.join('\n')}`;
    }

    if (!sub) return 'Usage: /feedback <text>\n       /feedback list';
    if (!ctx.feedbackStore) return 'Feedback store not available.';

    const context = ctx.lastAssistantMessage
      ? ctx.lastAssistantMessage.slice(0, 120)
      : '';

    const recent = ctx.engine.getMessages(ctx.conversationId, 6);
    const history = recent.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    }));

    ctx.feedbackStore.add(sub, context, history);
    const turnNote = history.length > 0 ? ` (captured last ${history.length} turns)` : '';
    return `Feedback saved${turnNote}. It will be applied during the next sleep cycle.`;
  },

  update: () => {
    // Resolution order:
    //   1. Running from a dev monorepo checkout (most common: ~/Developer/.../agent-os)
    //   2. Legacy ~/.agent-os-src source install
    //   3. npm/bun global package (`npm install -g agent-os`)
    const devRoot = findDevMonorepoRoot();
    const legacySrc = join(homedir(), '.agent-os-src');
    const hasBun = (() => { try { execSync('bun --version', { stdio: 'pipe' }); return true; } catch { return false; } })();
    const pkgInstall = hasBun ? 'bun install --silent' : 'npm install --silent --no-audit --no-fund';

    const srcDir = devRoot ?? (existsSync(legacySrc) ? legacySrc : null);

    if (srcDir) {
      const lines: string[] = [`⟳ dev install detected at ${srcDir}`];
      const hasGit = existsSync(join(srcDir, '.git'));
      if (hasGit) {
        try {
          const out = execSync('git pull --ff-only', {
            cwd: srcDir,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          lines.push(out.includes('Already up to date') ? '· already up to date' : '✓ pulled latest');
        } catch (err) {
          const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
          lines.push(`⚠ git pull skipped — ${msg}`);
        }
      } else {
        lines.push('· not a git checkout, skipping pull');
      }
      try {
        execSync(pkgInstall, { cwd: srcDir, stdio: ['pipe', 'pipe', 'pipe'] });
        lines.push(`✓ workspace deps synced (${hasBun ? 'bun' : 'npm'})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
        lines.push(`⚠ install warnings — ${msg}`);
      }
      try {
        execSync(hasBun ? 'bun run build' : 'npm run build', { cwd: srcDir, stdio: ['pipe', 'pipe', 'pipe'] });
        lines.push('✓ build complete');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `${lines.join('\n')}\n✗ build failed:\n${msg}`;
      }
      lines.push('', 'Restart aos (exit + re-run) to load the new build.');
      return lines.join('\n');
    }

    // No local source tree — try updating via the package manager.
    const cmd = hasBun ? 'bun update -g agent-os' : 'npm update -g agent-os --no-audit --no-fund';
    try {
      execSync(cmd, { stdio: 'pipe' });
      return `Updated via ${hasBun ? 'bun' : 'npm'}. Restart aos to use the new version.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      return `Update failed (${msg}).\nTry: npm install -g agent-os`;
    }
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
