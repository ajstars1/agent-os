/**
 * Skill Curator — background consolidation of the skills library.
 *
 * Inspired by Hermes Agent's curator.py but implemented in TypeScript.
 *
 * Lifecycle:
 *   active  → used in last 30 days
 *   stale   → unused 30–90 days  (still loaded, lower priority)
 *   archived → unused 90+ days   (not loaded, but never deleted)
 *
 * Consolidation:
 *   When 2+ skills share the same domain prefix (e.g. "github-*"), the
 *   curator spawns a minimal LLM call to merge them into an umbrella skill.
 *
 * Triggers (checked on every CLI startup):
 *   - Engine idle for 2+ hours  OR
 *   - Last curator run was 7+ days ago
 *
 * Pinned skills (pinned: true in YAML frontmatter) are never touched.
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Logger } from '@agent-os-core/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SkillLifecycle = 'active' | 'stale' | 'archived';

export interface SkillMeta {
  name: string;
  filePath: string;
  lastUsedMs: number;
  lifecycle: SkillLifecycle;
  pinned: boolean;
  domain: string; // first word of skill name, used for clustering
}

export interface CuratorState {
  lastRunMs: number;
  totalRuns: number;
  totalArchived: number;
  totalMerged: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STALE_DAYS = 30;
const ARCHIVE_DAYS = 90;
const MS_PER_DAY = 86_400_000;
const MIN_IDLE_MS = 2 * 60 * 60 * 1000;   // 2 hours
const MIN_RUN_INTERVAL_MS = 7 * MS_PER_DAY; // 7 days

// ─── State persistence ────────────────────────────────────────────────────────

function statePath(): string {
  const dir = join(homedir(), '.agent-os');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'curator-state.json');
}

function loadState(): CuratorState {
  try {
    const raw = readFileSync(statePath(), 'utf-8');
    return JSON.parse(raw) as CuratorState;
  } catch {
    return { lastRunMs: 0, totalRuns: 0, totalArchived: 0, totalMerged: 0 };
  }
}

function saveState(state: CuratorState): void {
  writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf-8');
}

// ─── Usage tracking ───────────────────────────────────────────────────────────

function usagePath(): string {
  return join(homedir(), '.agent-os', 'skill-usage.json');
}

function loadUsage(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(usagePath(), 'utf-8')) as Record<string, number>;
  } catch {
    return {};
  }
}

export function recordSkillUsage(skillName: string): void {
  const usage = loadUsage();
  usage[skillName] = Date.now();
  try {
    writeFileSync(usagePath(), JSON.stringify(usage, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

// ─── Skill scanning ───────────────────────────────────────────────────────────

function extractFrontmatter(content: string): Record<string, string | boolean> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string | boolean> = {};
  for (const line of match[1]!.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    result[key] = val === 'true' ? true : val === 'false' ? false : val;
  }
  return result;
}

async function scanSkillsDir(dir: string): Promise<SkillMeta[]> {
  const usage = loadUsage();
  const now = Date.now();
  const metas: SkillMeta[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const filePath = join(dir, entry);
    const name = basename(entry, '.md');

    let content = '';
    let mtimeMs = 0;
    try {
      content = await readFile(filePath, 'utf-8');
      const s = await stat(filePath);
      mtimeMs = s.mtimeMs;
    } catch {
      continue;
    }

    const fm = extractFrontmatter(content);
    const pinned = fm['pinned'] === true;
    const lastUsedMs = usage[name] ?? mtimeMs;
    const ageDays = (now - lastUsedMs) / MS_PER_DAY;

    const lifecycle: SkillLifecycle =
      ageDays >= ARCHIVE_DAYS ? 'archived' :
      ageDays >= STALE_DAYS   ? 'stale'    :
      'active';

    // Domain = first hyphen-delimited segment (e.g. "github-pr-review" → "github")
    const domain = name.split('-')[0]!.toLowerCase();

    metas.push({ name, filePath, lastUsedMs, lifecycle, pinned, domain });
  }

  return metas;
}

// ─── Lifecycle transitions ────────────────────────────────────────────────────

async function applyTransitions(
  metas: SkillMeta[],
  skillsDir: string,
  archiveDir: string,
  logger: Logger,
): Promise<number> {
  mkdirSync(archiveDir, { recursive: true });
  let archived = 0;

  for (const meta of metas) {
    if (meta.pinned) continue;
    if (meta.lifecycle !== 'archived') continue;

    // Move to archive dir instead of deleting
    try {
      const content = await readFile(meta.filePath, 'utf-8');
      const archivePath = join(archiveDir, basename(meta.filePath));
      await writeFile(archivePath, content, 'utf-8');
      // Don't actually delete — just note it. User can clean up manually.
      logger.info({ skill: meta.name, lifecycle: 'archived' }, '[Curator] Skill archived (unused 90+ days)');
      archived++;
    } catch (err) {
      logger.warn({ err, skill: meta.name }, '[Curator] Archive failed');
    }
  }

  return archived;
}

// ─── Domain clustering ────────────────────────────────────────────────────────

function findClusters(metas: SkillMeta[]): Map<string, SkillMeta[]> {
  const clusters = new Map<string, SkillMeta[]>();
  for (const meta of metas) {
    if (meta.lifecycle === 'archived' || meta.pinned) continue;
    const group = clusters.get(meta.domain) ?? [];
    group.push(meta);
    clusters.set(meta.domain, group);
  }
  // Only keep domains with 2+ skills (merge candidates)
  for (const [domain, group] of clusters.entries()) {
    if (group.length < 2) clusters.delete(domain);
  }
  return clusters;
}

// ─── Merge via LLM (optional) ─────────────────────────────────────────────────

async function mergeCluster(
  domain: string,
  skills: SkillMeta[],
  anthropicKey: string | undefined,
  logger: Logger,
): Promise<string | null> {
  if (!anthropicKey) return null;
  if (skills.length < 2) return null;

  try {
    const contents = await Promise.all(
      skills.slice(0, 4).map(async (s) => {
        const raw = await readFile(s.filePath, 'utf-8');
        return `### ${s.name}\n${raw.slice(0, 600)}`;
      }),
    );

    const prompt = `You are merging related skill files into one umbrella skill.
Domain: "${domain}"

These ${skills.length} skills share the same domain. Merge them into ONE umbrella skill file.
Use YAML frontmatter with: name, description, version: 1.0, tags.
Keep all unique procedures. Use "When to Use" and "Procedure" sections.
Return only the merged Markdown skill file, no explanation.

Skills to merge:
${contents.join('\n\n---\n\n')}`;

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: anthropicKey });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content.find((c) => c.type === 'text')?.text ?? '';
    return text.trim() || null;
  } catch (err) {
    logger.warn({ err, domain }, '[Curator] Merge LLM call failed');
    return null;
  }
}

// ─── Main curator run ─────────────────────────────────────────────────────────

export interface CuratorOptions {
  skillsDir?: string;
  anthropicKey?: string;
  force?: boolean;
  logger: Logger;
}

export interface CuratorResult {
  ran: boolean;
  reason?: string;
  archived: number;
  merged: number;
  clusters: number;
  nextRunIn: string;
}

export async function runCurator(opts: CuratorOptions): Promise<CuratorResult> {
  const skillsDir = opts.skillsDir ?? join(homedir(), '.agent-os', 'skills');
  const archiveDir = join(skillsDir, 'archived');
  const state = loadState();
  const now = Date.now();

  if (!opts.force) {
    const timeSinceRun = now - state.lastRunMs;
    if (timeSinceRun < MIN_RUN_INTERVAL_MS) {
      const daysUntil = Math.ceil((MIN_RUN_INTERVAL_MS - timeSinceRun) / MS_PER_DAY);
      return {
        ran: false,
        reason: `Next run in ${daysUntil} day(s)`,
        archived: 0,
        merged: 0,
        clusters: 0,
        nextRunIn: `${daysUntil}d`,
      };
    }
  }

  opts.logger.info({ skillsDir }, '[Curator] Starting run');

  const metas = await scanSkillsDir(skillsDir);
  if (metas.length === 0) {
    return { ran: true, archived: 0, merged: 0, clusters: 0, nextRunIn: '7d' };
  }

  // 1. Apply lifecycle transitions
  const archived = await applyTransitions(metas, skillsDir, archiveDir, opts.logger);

  // 2. Find merge candidates
  const clusters = findClusters(metas);
  let merged = 0;

  for (const [domain, skills] of clusters.entries()) {
    const umbrella = await mergeCluster(domain, skills, opts.anthropicKey, opts.logger);
    if (!umbrella) continue;

    const umbrellaPath = join(skillsDir, `${domain}-umbrella.md`);
    try {
      await writeFile(umbrellaPath, umbrella, 'utf-8');
      opts.logger.info({ domain, count: skills.length, path: umbrellaPath }, '[Curator] Merged cluster');
      merged++;
    } catch (err) {
      opts.logger.warn({ err, domain }, '[Curator] Failed to write umbrella skill');
    }
  }

  // 3. Save state
  const newState: CuratorState = {
    lastRunMs: now,
    totalRuns: state.totalRuns + 1,
    totalArchived: state.totalArchived + archived,
    totalMerged: state.totalMerged + merged,
  };
  saveState(newState);

  opts.logger.info(
    { archived, merged, clusters: clusters.size, totalSkills: metas.length },
    '[Curator] Run complete',
  );

  return {
    ran: true,
    archived,
    merged,
    clusters: clusters.size,
    nextRunIn: '7d',
  };
}

/** Check if curator should run now (idle-triggered). */
export function shouldRunCurator(lastActivityMs: number): boolean {
  const state = loadState();
  const now = Date.now();
  const idleSince = now - lastActivityMs;
  const sinceLastRun = now - state.lastRunMs;
  return idleSince >= MIN_IDLE_MS || sinceLastRun >= MIN_RUN_INTERVAL_MS;
}
