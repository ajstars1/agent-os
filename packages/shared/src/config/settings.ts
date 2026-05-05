/**
 * Layered JSON settings system — mirrors Claude Code's settings hierarchy.
 *
 * Merge order (lowest → highest priority):
 *   1. Built-in defaults
 *   2. ~/.agent-os/settings.json   (global user settings)
 *   3. .agent-os/settings.json    (project settings — checked in)
 *   4. .agent-os/settings.local.json (local overrides — gitignored)
 *   5. Environment variables        (highest priority, via loadConfig())
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { HookBinding } from '../types/hooks.js';

export interface SettingsJson {
  /** Override the default LLM model. */
  defaultModel?: 'claude' | 'gemini' | 'openrouter' | 'ollama' | 'auto';
  /** Hooks fired on tool events. */
  hooks?: HookBinding[];
  /** Per-tool permission overrides. */
  permissions?: {
    /** Tools allowed without confirmation. */
    allow?: string[];
    /** Tools always requiring confirmation. */
    deny?: string[];
  };
  /** Extra directories the agent can read/write. */
  allowedDirs?: string[];
  /** Keybindings overrides. */
  keybindings?: Record<string, string>;
  /** Model-specific config. */
  model?: {
    openrouter?: { model: string };
    ollama?: { model: string; baseUrl?: string };
  };
  /** Gateway platform tokens (keys only — secrets stay in env or local settings). */
  gateway?: {
    platforms?: {
      telegram?: { enabled?: boolean };
      slack?: { enabled?: boolean };
      discord?: { enabled?: boolean };
      whatsapp?: { enabled?: boolean };
      matrix?: { enabled?: boolean };
      email?: { enabled?: boolean };
    };
  };
  /** Skill curator config. */
  curator?: {
    enabled?: boolean;
    idleHours?: number;
    runIntervalDays?: number;
  };
  /** Cron scheduler settings. */
  cron?: {
    enabled?: boolean;
    pollIntervalSeconds?: number;
  };
  /** Browser automation. */
  browser?: {
    backend?: 'local' | 'browser-use' | 'camofox';
  };
}

function readJsonSafe(filePath: string): SettingsJson | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (!raw) return null;
    return JSON.parse(raw) as SettingsJson;
  } catch {
    return null;
  }
}

function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as Array<keyof T>) {
    const baseVal = base[key];
    const overVal = override[key];
    if (
      overVal !== undefined &&
      typeof baseVal === 'object' && baseVal !== null &&
      typeof overVal === 'object' && overVal !== null &&
      !Array.isArray(baseVal) && !Array.isArray(overVal)
    ) {
      (result as Record<string, unknown>)[key as string] = deepMerge(baseVal as object, overVal as object);
    } else if (overVal !== undefined) {
      (result as Record<string, unknown>)[key as string] = overVal;
    }
  }
  return result;
}

export function loadSettings(cwd = process.cwd()): SettingsJson {
  const globalPath = join(homedir(), '.agent-os', 'settings.json');
  const projectPath = join(cwd, '.agent-os', 'settings.json');
  const localPath = join(cwd, '.agent-os', 'settings.local.json');

  const layers: SettingsJson[] = [
    readJsonSafe(globalPath),
    readJsonSafe(projectPath),
    readJsonSafe(localPath),
  ].filter((l): l is SettingsJson => l !== null);

  return layers.reduce<SettingsJson>((acc, layer) => deepMerge(acc, layer), {});
}

/** Write to the specified settings file atomically. */
export function writeSettings(
  scope: 'global' | 'project' | 'local',
  patch: Partial<SettingsJson>,
  cwd = process.cwd(),
): void {
  const paths = {
    global: join(homedir(), '.agent-os', 'settings.json'),
    project: join(cwd, '.agent-os', 'settings.json'),
    local: join(cwd, '.agent-os', 'settings.local.json'),
  };
  const targetPath = resolve(paths[scope]);
  const dir = join(targetPath, '..');
  mkdirSync(dir, { recursive: true });
  const existing = readJsonSafe(targetPath) ?? {};
  const merged = deepMerge(existing, patch);
  writeFileSync(targetPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

export function getSettingsPath(scope: 'global' | 'project' | 'local', cwd = process.cwd()): string {
  const paths = {
    global: join(homedir(), '.agent-os', 'settings.json'),
    project: join(cwd, '.agent-os', 'settings.json'),
    local: join(cwd, '.agent-os', 'settings.local.json'),
  };
  return paths[scope];
}
