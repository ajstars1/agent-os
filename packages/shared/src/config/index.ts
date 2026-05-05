import { z } from 'zod';
import type { Config } from '../types/index.js';
import { loadSettings } from './settings.js';

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_ALLOWED_CHANNELS: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  SLACK_BOT_TOKEN: z.string().optional(),
  SKILLS_DIR: z.string().default('~/.claude/skills'),
  CLAUDE_MD_PATH: z.string().default('./CLAUDE.md'),
  DB_PATH: z.string().default('~/.agent-os/memory.db'),
  DEFAULT_MODEL: z.enum(['claude', 'gemini', 'openrouter', 'ollama', 'auto']).default('auto'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  WEB_PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  WEB_CORS_ORIGIN: z.string().default('*'),
  AGENTS_DIR: z.string().default('~/.agent-os/agents'),
  ALLOWED_DIRS: z.string().optional(),
  NEURAL_ENGINE_URL: z.string().default('http://localhost:8765'),
  CONFIG_UI_PORT: z.coerce.number().int().min(1024).max(65535).default(7877),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  // Layer JSON settings on top of env defaults
  const settings = loadSettings();
  const config: Config = {
    ...result.data,
    // Settings.json can override defaultModel
    DEFAULT_MODEL: (settings.defaultModel ?? result.data.DEFAULT_MODEL) as Config['DEFAULT_MODEL'],
    // Merge allowedDirs from settings into ALLOWED_DIRS env string
    ALLOWED_DIRS: [
      ...(result.data.ALLOWED_DIRS ? result.data.ALLOWED_DIRS.split(':') : []),
      ...(settings.allowedDirs ?? []),
    ].filter(Boolean).join(':') || undefined,
    // Attach hooks for engine use
    hooks: settings.hooks,
  };

  return config;
}
