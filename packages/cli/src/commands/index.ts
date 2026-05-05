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
  /model openrouter|or:<id>       Route to OpenRouter (or:gpt-4o, or:llama-3, or:mixtral...)
  /model ollama|ol:<model>        Route to local Ollama (ol:llama3.2, ol:codellama...)
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
  /plan <task>                    Enter Planning Mode for a complex task
  /task list                      Show subtasks for the current plan
  /task done <subtask_id>         Mark a subtask as completed
  /status                         Show agent health and memory stats
  /mcp                            List active MCP servers
  /export [filename]              Export conversation to markdown
  /cd <path>                      Change working directory
  /cwd                            Print current working directory
  /dream                          Run memory consolidation sleep cycle
  /dream journal                  Show last 3 dream journal entries (what changed)
  /voice                          Switch to voice mode (mic → Whisper → agent → TTS)
  /agents                         List agent profiles
  /gateway                        Show platform gateway status (Telegram, Discord, Slack, etc.)
  /skills list                    List all available skills (bundled + installed)
  /skills search <query>          Search hub for community skills
  /skills install <id>            Install from hub (category/name) or GitHub URL
  /skills publish <name>          Publish a skill to the hub (requires HUB_TOKEN)
  /cron list                      List scheduled cron jobs
  /cron add "name" --schedule "0 9 * * *" --prompt "..." --deliver discord
  /cron pause|resume|delete <name>
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
    const staticValid = ['claude', 'gemini', 'auto', 'gemini:flash', 'gemini:pro', 'gemini:flash-thinking', 'gemini:pro-thinking'];
    const isValid = staticValid.includes(model)
      || model.startsWith('or:')   // or:openai/gpt-4o, or:gpt-4o-mini ...
      || model.startsWith('ol:')   // ol:llama3.2, ol:codellama ...
      || model === 'openrouter'
      || model === 'ollama';
    if (!isValid) {
      return `Invalid model. Choose:\n  claude | gemini | auto\n  gemini:flash | gemini:pro | gemini:flash-thinking | gemini:pro-thinking\n  openrouter | or:<model-id>   (e.g. or:gpt-4o, or:openai/gpt-4o)\n  ollama | ol:<model>           (e.g. ol:llama3.2, ol:codellama)`;
    }
    ctx.currentModel.value = model;
    const labels: Record<string, string> = {
      'gemini:flash': 'Gemini 2.0 Flash',
      'gemini:pro': 'Gemini 1.5 Pro',
      'gemini:flash-thinking': 'Gemini Flash Thinking',
      'gemini:pro-thinking': 'Gemini 2.5 Pro + Thinking',
      'openrouter': 'OpenRouter (default: gpt-4o-mini)',
      'ollama': 'Ollama (local, default: llama3.2)',
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

  skills: async (args, ctx) => {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0] ?? 'list';

    if (!sub || sub === 'list') {
      const names = ctx.skills.getSkillNames();
      if (names.length === 0) return 'No skills loaded.';
      const lines = names.map((n) => `  /${n}`);
      return `Skills (${names.length}):\n${lines.join('\n')}\n\nRun /skills search <query> to find more on the hub.`;
    }

    if (sub === 'search') {
      const query = parts.slice(1).join(' ');
      if (!query) return 'Usage: /skills search <query>';
      try {
        const { searchSkills } = await import('@agent-os-core/core/skills/hub') as { searchSkills: typeof import('@agent-os-core/core/skills/hub').searchSkills };
        const result = await searchSkills(query, { limit: 8 });
        if (result.entries.length === 0) return `No skills found for "${query}" (source: ${result.source})`;
        const lines = result.entries.map((e) =>
          `  ${e.id}\n    ${e.description} ★${e.stars}`
        );
        return `Skills matching "${query}" (${result.total} total, source: ${result.source}):\n\n${lines.join('\n\n')}\n\nInstall with: /skills install <id>`;
      } catch (err) {
        return `Search failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (sub === 'install') {
      const identifier = parts.slice(1).join(' ');
      if (!identifier) return 'Usage: /skills install <category/name | github.com/user/repo | URL>';
      try {
        const { installSkill } = await import('@agent-os-core/core/skills/hub') as { installSkill: typeof import('@agent-os-core/core/skills/hub').installSkill };
        const skillsDir = process.env['SKILLS_DIR'] ?? '~/.claude/skills';
        const result = await installSkill(identifier, skillsDir, {
          hubToken: process.env['HUB_TOKEN'],
        });
        if (result.success) {
          await ctx.skills.load();
          return `✓ ${result.message}\nReloaded ${ctx.skills.getSkillNames().length} skills.`;
        }
        return `✗ ${result.message}`;
      } catch (err) {
        return `Install failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (sub === 'publish') {
      const skillName = parts[1];
      if (!skillName) return 'Usage: /skills publish <name>';
      const hubToken = process.env['HUB_TOKEN'];
      if (!hubToken) return 'HUB_TOKEN environment variable required to publish skills.';
      try {
        const { publishSkill } = await import('@agent-os-core/core/skills/hub') as { publishSkill: typeof import('@agent-os-core/core/skills/hub').publishSkill };
        const skillsDir = process.env['SKILLS_DIR'] ?? '~/.claude/skills';
        const result = await publishSkill(skillName, skillsDir, hubToken);
        return result.success ? `✓ ${result.message}${result.url ? `\n  URL: ${result.url}` : ''}` : `✗ ${result.message}`;
      } catch (err) {
        return `Publish failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return `Unknown subcommand. Usage:\n  /skills list\n  /skills search <query>\n  /skills install <id>\n  /skills publish <name>`;
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

  dream: async (args, ctx) => {
    const sub = args.trim();
    if (sub === 'journal' || sub === 'log') {
      // Fetch and display dream journal from neural engine
      try {
        const res = await fetch(`${process.env['NEURAL_ENGINE_URL'] ?? 'http://localhost:8765'}/dream/journal?limit=3`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return 'Dream journal not available (is the neural engine running?)';
        const entries = await res.json() as Array<Record<string, unknown>>;
        if (!entries.length) return 'No dream journal entries yet. Run /dream first to generate one.';

        return entries.map((e) => {
          const lines: string[] = [`## Dream — ${String(e['date'] ?? 'unknown')}`];
          const mem = e['memory'] as Record<string, unknown> | undefined;
          if (mem) {
            lines.push(`Episodes: ${String(mem['total_episodes'] ?? '?')} | Topics tracked: ${String(mem['tracked_topics'] ?? '?')}`);
            const topics = mem['top_interests'] as Array<{topic: string; weight: number}> | undefined;
            if (topics?.length) {
              lines.push(`Top interests: ${topics.map((t) => `${t.topic}(${t.weight.toFixed(2)})`).join(', ')}`);
            }
          }
          const sleep = e['sleep'] as Record<string, unknown> | undefined;
          if (sleep) {
            lines.push(`Pruned: ${String(sleep['messages_pruned'] ?? 0)} messages, retained ${String(sleep['messages_retained'] ?? 0)}`);
          }
          const preds = e['predictions'] as Array<{topic: string; confidence: number}> | undefined;
          if (preds?.length) {
            lines.push(`Tomorrow's predictions: ${preds.slice(0, 3).map((p) => `${p.topic}(${p.confidence})`).join(', ')}`);
          }
          const obs = e['observations'] as string[] | undefined;
          if (obs?.length) obs.forEach((o) => lines.push(`• ${o}`));
          return lines.join('\n');
        }).join('\n\n---\n\n');
      } catch {
        return 'Dream journal not available (neural engine offline).';
      }
    }

    try {
      ctx.engine.startSleepCycle();
      return 'Sleep cycle started — memory consolidation in progress.\nRun /dream journal to see what changed.';
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: ${msg}`;
    }
  },

  voice: async (_args, ctx) => {
    try {
      const { runVoiceLoop } = await import('@agent-os-core/voice');
      await runVoiceLoop({
        engine: ctx.engine,
        conversationId: ctx.conversationId,
        ttsBackend: process.env['ELEVENLABS_API_KEY'] ? 'elevenlabs' : process.env['OPENAI_API_KEY'] ? 'openai' : 'system',
        openaiKey: process.env['OPENAI_API_KEY'],
        elevenLabsKey: process.env['ELEVENLABS_API_KEY'],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Voice mode unavailable: ${msg}\nRun: aos --voice to use voice mode, or install @agent-os-core/voice.`;
    }
    return '';
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
  
  plan: (args, ctx) => {
    if (!args.trim()) return 'Usage: /plan <task description>';
    const task = ctx.engine.planningManager.enterPlanMode(args, ['Initial analysis', 'Implementation', 'Verification']);
    return `Entered Planning Mode for: ${task.title}\n\nTasks:\n${task.subtasks.map(s => `  [ ] ${s.title} (${s.id.slice(0, 4)})`).join('\n')}\n\nType "Approve" to start or "Reject" to cancel.`;
  },

  task: (args, ctx) => {
    const [subCmd, id] = args.trim().split(/\s+/);
    if (subCmd === 'list') {
      const plan = ctx.engine.planningManager.getCurrentPlan();
      if (!plan) return 'No active plan. Use /plan to start one.';
      return `Current Plan: ${plan.title}\n\n${plan.subtasks.map(s => `  [${s.status === 'completed' ? 'x' : ' '}] ${s.title} (${s.id.slice(0, 4)})`).join('\n')}`;
    }
    if (subCmd === 'done') {
      const plan = ctx.engine.planningManager.getCurrentPlan();
      if (!plan || !id) return 'Usage: /task done <id>';
      const subtask = plan.subtasks.find(s => s.id.startsWith(id));
      if (!subtask) return `Subtask ${id} not found.`;
      ctx.engine.taskRegistry.updateSubtaskStatus(plan.id, subtask.id, 'completed');
      return `Marked subtask "${subtask.title}" as done.`;
    }
    return 'Usage: /task <list|done>';
  },

  status: (_args, ctx) => {
    const memory = ctx.hamStore ? `${ctx.hamStore.getAllL0().length} topics` : 'Off';
    const mode = ctx.engine.planningManager.getMode().toUpperCase();
    return `AgentOS Status:\n  Mode:     ${mode}\n  Memory:   ${memory}\n  Conversation: ${ctx.conversationId.slice(0, 8)}`;
  },

  mcp: () => {
    // Basic placeholder for MCP command
    return 'Active MCP Servers: (builtin, file-system, web-search)';
  },

  update: () => {
    // Resolution order:
    //   1. Running from a dev monorepo checkout (most common: ~/Developer/.../agent-os)
    //   2. Legacy ~/.agent-os-src source install
    //   3. npm/bun global package (`npm install -g agent-os`)
    const devRoot = findDevMonorepoRoot();
    const legacySrc = join(homedir(), '.agent-os-src');
    const bunPath = join(homedir(), '.bun/bin/bun');
    const hasBun = existsSync(bunPath) || (() => { try { execSync('bun --version', { stdio: 'pipe' }); return true; } catch { return false; } })();
    const bunCmd = existsSync(bunPath) ? bunPath : 'bun';
    const pkgInstall = `${bunCmd} install --silent`;

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
        lines.push('✓ workspace deps synced (bun)');
      } catch (err) {
        const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
        lines.push(`⚠ install warnings — ${msg}`);
      }
      try {
        execSync(`${bunCmd} run build`, { cwd: srcDir, stdio: ['pipe', 'pipe', 'pipe'] });
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

  gateway: async (args) => {
    const sub = args.trim().split(/\s+/)[0] ?? 'status';

    if (sub === 'status' || sub === 'list') {
      const checks: Record<string, string[]> = {
        telegram: ['TELEGRAM_BOT_TOKEN'],
        discord: ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID'],
        slack: ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'],
        whatsapp: ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN'],
        signal: ['SIGNAL_CLI_URL', 'SIGNAL_NUMBER'],
        matrix: ['MATRIX_HOMESERVER_URL', 'MATRIX_ACCESS_TOKEN', 'MATRIX_USER_ID'],
        email: ['EMAIL_IMAP_HOST', 'EMAIL_USER', 'EMAIL_PASSWORD'],
      };
      const lines = ['Platform gateway status:\n'];
      for (const [name, vars] of Object.entries(checks)) {
        const missing = vars.filter((v) => !process.env[v]);
        const ok = missing.length === 0;
        lines.push(`  ${ok ? '✅' : '○ '} ${name.padEnd(12)} ${ok ? 'configured' : `missing: ${missing.join(', ')}`}`);
      }
      lines.push('\nStart with: aos-gateway\nOr for specific platforms: aos-gateway --only telegram,discord');
      return lines.join('\n');
    }

    return 'Usage: /gateway [status]\nTo start the daemon: aos-gateway (or: aos-gateway --only telegram,discord)';
  },

  cron: async (args) => {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0] ?? 'list';

    try {
      const { createJob, listJobs, enableJob, deleteJob, CreateJobSchema } = await import('@agent-os-core/cron');

      if (sub === 'list') {
        const jobs = listJobs();
        if (jobs.length === 0) return 'No cron jobs. Add one: /cron add "name" --schedule "0 9 * * *" --prompt "..." --deliver local';
        return jobs.map((j) => {
          const next = new Date(j.nextRunAt).toLocaleString();
          const status = j.lastStatus ? ` [${j.lastStatus}]` : '';
          const enabled = j.enabled ? '' : ' (paused)';
          return `  ${j.enabled ? '●' : '○'} ${j.name}${enabled}${status} — next: ${next}\n    schedule: ${j.schedule} → deliver: ${j.deliver}\n    ${j.prompt.slice(0, 80)}${j.prompt.length > 80 ? '...' : ''}`;
        }).join('\n\n');
      }

      if (sub === 'add') {
        // /cron add "name" --schedule "..." --prompt "..." --deliver local
        const nameMatch = args.match(/add\s+"([^"]+)"/);
        const schedMatch = args.match(/--schedule\s+"([^"]+)"/);
        const promptMatch = args.match(/--prompt\s+"([^"]+)"/);
        const deliverMatch = args.match(/--deliver\s+(\S+)/);
        if (!nameMatch || !schedMatch || !promptMatch) {
          return 'Usage: /cron add "job-name" --schedule "0 9 * * *" --prompt "..." --deliver local';
        }
        const parsed = CreateJobSchema.safeParse({
          name: nameMatch[1],
          schedule: schedMatch[1],
          prompt: promptMatch[1],
          deliver: deliverMatch?.[1] ?? 'local',
        });
        if (!parsed.success) return `Invalid: ${parsed.error.message}`;
        const job = createJob(parsed.data);
        return `Cron job created: ${job.name}\nNext run: ${new Date(job.nextRunAt).toLocaleString()}\nDeliver: ${job.deliver}`;
      }

      if (sub === 'pause' || sub === 'resume') {
        const name = parts[1];
        if (!name) return `Usage: /cron ${sub} <name>`;
        const jobs = listJobs();
        const job = jobs.find((j) => j.name === name);
        if (!job) return `Job not found: ${name}`;
        enableJob(job.id, sub === 'resume');
        return `Job ${sub}d: ${name}`;
      }

      if (sub === 'delete') {
        const name = parts[1];
        if (!name) return 'Usage: /cron delete <name>';
        const jobs = listJobs();
        const job = jobs.find((j) => j.name === name);
        if (!job) return `Job not found: ${name}`;
        deleteJob(job.id);
        return `Job deleted: ${name}`;
      }

      return 'Usage: /cron [list|add|pause|resume|delete]';
    } catch (err) {
      return `Cron not available: ${err instanceof Error ? err.message : String(err)}\nInstall with: npm install -g @agent-os-core/cron`;
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
