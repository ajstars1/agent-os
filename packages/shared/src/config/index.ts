import { z } from 'zod';
import type { Config } from '../types/index.js';

const configSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  GOOGLE_API_KEY: z.string().optional(),
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_ALLOWED_CHANNELS: z.string().optional(),
  SKILLS_DIR: z.string().default('~/.claude/skills'),
  CLAUDE_MD_PATH: z.string().default('./CLAUDE.md'),
  DB_PATH: z.string().default('~/.agent-os/memory.db'),
  DEFAULT_MODEL: z.enum(['claude', 'gemini', 'auto']).default('auto'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Phase 2
  WEB_PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  WEB_CORS_ORIGIN: z.string().default('*'),
  AGENTS_DIR: z.string().default('~/.agent-os/agents'),
  ALLOWED_DIRS: z.string().optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${result.error.toString()}`);
  }
  return result.data as Config;
}
