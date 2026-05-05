/**
 * Skills Hub — install, search, and publish skills.
 *
 * Install sources:
 *   "productivity/daily-briefing"          → official hub (agentskills.io API)
 *   "github.com/user/repo"                 → GitHub repo root SKILL.md
 *   "github.com/user/repo/path/skill.md"   → specific file in GitHub
 *   "https://example.com/skill.md"         → raw URL
 *
 * Security: every install runs guard.ts scan. Dangerous verdict blocks install.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { scanSkill, formatGuardResult } from './guard.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HubSkillEntry {
  id: string;           // "productivity/daily-briefing"
  name: string;
  description: string;
  category: string;
  tags: string[];
  author: string;
  stars: number;
  downloadUrl: string;
}

export interface InstallResult {
  success: boolean;
  skillName: string;
  path?: string;
  message: string;
  guardVerdict?: string;
}

export interface SearchResult {
  entries: HubSkillEntry[];
  total: number;
  source: 'hub' | 'github';
}

const HUB_BASE_URL = 'https://agentskills.io/api/v1';
const GITHUB_RAW = 'https://raw.githubusercontent.com';
const GITHUB_API = 'https://api.github.com';

const FETCH_TIMEOUT = 15_000;

// ─── URL resolution ───────────────────────────────────────────────────────────

function resolveDownloadUrl(identifier: string): { url: string; source: 'hub' | 'github' | 'url'; skillName: string } {
  // Direct URL
  if (identifier.startsWith('https://') || identifier.startsWith('http://')) {
    const slug = basename(identifier).replace('.md', '');
    return { url: identifier, source: 'url', skillName: slug };
  }

  // github.com/user/repo[/optional/path/skill.md]
  const ghMatch = identifier.match(/^(?:github\.com\/)([\w.-]+)\/([\w.-]+)(?:\/(.+))?$/);
  if (ghMatch) {
    const [, user, repo, path] = ghMatch;
    const filePath = path ?? 'SKILL.md';
    const url = `${GITHUB_RAW}/${user}/${repo}/main/${filePath}`;
    const skillName = basename(filePath as string).replace('.md', '');
    return { url, source: 'github', skillName };
  }

  // hub identifier: "category/name"
  const hubUrl = `${HUB_BASE_URL}/skills/${encodeURIComponent(identifier)}/raw`;
  const skillName = identifier.split('/').pop() ?? identifier;
  return { url: hubUrl, source: 'hub', skillName };
}

// ─── Install ──────────────────────────────────────────────────────────────────

export async function installSkill(
  identifier: string,
  skillsDir: string,
  opts: { force?: boolean; hubToken?: string } = {},
): Promise<InstallResult> {
  const { url, source, skillName } = resolveDownloadUrl(identifier);
  const expandedDir = skillsDir.startsWith('~') ? skillsDir.replace('~', homedir()) : skillsDir;

  // Fetch the skill content
  let content: string;
  try {
    const headers: Record<string, string> = {
      Accept: 'text/plain, text/markdown, */*',
    };
    if (source === 'hub' && opts.hubToken) {
      headers['Authorization'] = `Bearer ${opts.hubToken}`;
    }
    if (source === 'github') {
      headers['Accept'] = 'application/vnd.github.raw+json';
    }

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!res.ok) {
      if (res.status === 404) {
        return { success: false, skillName, message: `Skill not found: ${identifier}` };
      }
      return { success: false, skillName, message: `Fetch failed: HTTP ${res.status}` };
    }

    content = await res.text();
  } catch (err) {
    return { success: false, skillName, message: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Security scan
  const guardResult = scanSkill(content, skillName);

  if (guardResult.verdict === 'dangerous') {
    return {
      success: false,
      skillName,
      message: `Install blocked by security scanner:\n${formatGuardResult(guardResult, skillName)}`,
      guardVerdict: 'dangerous',
    };
  }

  // Write to skills dir
  mkdirSync(expandedDir, { recursive: true });
  const skillPath = join(expandedDir, `${skillName}.md`);

  if (existsSync(skillPath) && !opts.force) {
    return {
      success: false,
      skillName,
      message: `Skill "${skillName}" already exists. Use --force to overwrite.`,
    };
  }

  writeFileSync(skillPath, content, 'utf-8');

  const warningNote = guardResult.verdict === 'warning'
    ? `\n⚠  Security warnings:\n${formatGuardResult(guardResult, skillName)}`
    : '';

  return {
    success: true,
    skillName,
    path: skillPath,
    message: `Installed "${skillName}" from ${source}.${warningNote}`,
    guardVerdict: guardResult.verdict,
  };
}

// ─── Search ───────────────────────────────────────────────────────────────────

export async function searchSkills(
  query: string,
  opts: { hubToken?: string; limit?: number } = {},
): Promise<SearchResult> {
  const limit = opts.limit ?? 10;

  // Try hub first
  try {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const headers: Record<string, string> = {};
    if (opts.hubToken) headers['Authorization'] = `Bearer ${opts.hubToken}`;

    const res = await fetch(`${HUB_BASE_URL}/skills/search?${params}`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (res.ok) {
      const data = await res.json() as { entries: HubSkillEntry[]; total: number };
      return { entries: data.entries, total: data.total, source: 'hub' };
    }
  } catch {
    // Hub unreachable — fall through to GitHub search
  }

  // Fallback: GitHub code search
  try {
    const params = new URLSearchParams({
      q: `${query} SKILL.md in:path language:Markdown`,
      per_page: String(Math.min(limit, 30)),
    });

    const res = await fetch(`${GITHUB_API}/search/code?${params}`, {
      headers: { Accept: 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (res.ok) {
      const data = await res.json() as { items: Array<{ name: string; path: string; repository: { full_name: string; description: string | null; stargazers_count?: number } }>; total_count: number };
      const entries: HubSkillEntry[] = data.items.map((item) => ({
        id: `github.com/${item.repository.full_name}/${item.path}`,
        name: item.name.replace('.md', ''),
        description: item.repository.description ?? '',
        category: 'community',
        tags: [],
        author: item.repository.full_name.split('/')[0] ?? '',
        stars: item.repository.stargazers_count ?? 0,
        downloadUrl: `${GITHUB_RAW}/${item.repository.full_name}/main/${item.path}`,
      }));

      return { entries, total: data.total_count, source: 'github' };
    }
  } catch {
    // GitHub also unreachable
  }

  return { entries: [], total: 0, source: 'hub' };
}

// ─── Publish ──────────────────────────────────────────────────────────────────

export async function publishSkill(
  skillName: string,
  skillsDir: string,
  hubToken: string,
): Promise<{ success: boolean; message: string; url?: string }> {
  const expandedDir = skillsDir.startsWith('~') ? skillsDir.replace('~', homedir()) : skillsDir;
  const skillPath = join(expandedDir, `${skillName}.md`);

  if (!existsSync(skillPath)) {
    return { success: false, message: `Skill file not found: ${skillPath}` };
  }

  const content = readFileSync(skillPath, 'utf-8');

  // Scan before publish
  const guardResult = scanSkill(content, skillName);
  if (guardResult.verdict === 'dangerous') {
    return { success: false, message: `Cannot publish: dangerous patterns detected.\n${formatGuardResult(guardResult, skillName)}` };
  }

  try {
    const res = await fetch(`${HUB_BASE_URL}/skills`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hubToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: skillName, content }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      return { success: false, message: `Publish failed: HTTP ${res.status} — ${err}` };
    }

    const data = await res.json() as { url?: string; id?: string };
    return {
      success: true,
      message: `Published "${skillName}" to skills hub.`,
      url: data.url,
    };
  } catch (err) {
    return { success: false, message: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── List hub categories ──────────────────────────────────────────────────────

export async function listHubCategories(hubToken?: string): Promise<string[]> {
  try {
    const headers: Record<string, string> = {};
    if (hubToken) headers['Authorization'] = `Bearer ${hubToken}`;

    const res = await fetch(`${HUB_BASE_URL}/categories`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (res.ok) {
      const data = await res.json() as { categories: string[] };
      return data.categories;
    }
  } catch {
    // unreachable
  }

  // Fallback: built-in category list
  return [
    'productivity', 'devops', 'github', 'data-science', 'research',
    'creative', 'software-development', 'writing', 'learning', 'security',
    'ml-ops', 'social-media', 'note-taking', 'diagramming', 'gaming',
  ];
}
