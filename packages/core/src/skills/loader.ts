import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir as getHomedir } from 'node:os';
import { watch, type FSWatcher } from 'chokidar';
import type { Logger } from '@agent-os-core/shared';
import { SkillRecommender } from './recommender.js';

/** Extract the `description` field from YAML frontmatter (first `---` block). */
function extractFrontmatterDescription(content: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match || !match[1]) return '';
  const lines = match[1].split('\n');
  const descIdx = lines.findIndex((l) => l.startsWith('description:'));
  if (descIdx === -1) return '';
  // Single-line: `description: foo`
  const inline = lines[descIdx]!.replace(/^description:\s*["']?/, '').replace(/["']?\s*$/, '').replace(/\|$/, '').trim();
  if (inline && inline !== '|') return inline.split('\n')[0] ?? '';
  // Multi-line block scalar — collect indented lines after description:
  const indented: string[] = [];
  for (let i = descIdx + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s+/.test(l)) { indented.push(l.trim()); } else { break; }
  }
  return indented.join(' ').slice(0, 120);
}

function expandPath(p: string): string {
  return p.startsWith('~') ? p.replace('~', getHomedir()) : p;
}

/**
 * Walk up the directory tree from `startDir` until home dir or filesystem root.
 * Returns all CLAUDE.md paths found, from deepest (project) to shallowest.
 */
function findProjectClaudeMds(startDir: string): string[] {
  const home = getHomedir();
  const found: string[] = [];
  let current = startDir;

  while (true) {
    const candidate = join(current, 'CLAUDE.md');
    if (existsSync(candidate)) {
      found.push(candidate);
    }

    // Stop at home dir or filesystem root
    if (current === home || current === dirname(current)) {
      break;
    }
    current = dirname(current);
  }

  // Reverse so shallowest (closest to root) comes first,
  // but project-specific (deepest) comes last.
  // The caller prepends global CLAUDE.md, so we return project ones
  // ordered from outermost to innermost (i.e. reversed found array).
  return found.reverse();
}

export class SkillLoader {
  private cachedContext: string | null = null;
  private skillContents = new Map<string, string>(); // name → full SKILL.md content
  private watcher: FSWatcher | null = null;
  private hasWarnedENOSPC = false;
  private readonly reloadCallbacks: Array<() => void> = [];
  readonly recommender: SkillRecommender = new SkillRecommender();

  constructor(
    private readonly skillsDir: string,
    private readonly claudeMdPath: string,
    private readonly logger: Logger,
  ) {}

  /** Full SKILL.md content for a named skill, with {{args}} not yet replaced. */
  getSkillContent(name: string): string | null {
    return this.skillContents.get(name) ?? null;
  }

  /** Names of all loaded skills. */
  getSkillNames(): string[] {
    return [...this.skillContents.keys()];
  }

  async load(): Promise<void> {
    const parts: string[] = [];
    const skillRaws: Array<{ name: string; content: string }> = [];
    const skillStubs: string[] = [];
    const skillsPath = expandPath(this.skillsDir);
    const claudePath = expandPath(this.claudeMdPath);

    this.skillContents.clear();

    // Load global CLAUDE.md (configured path)
    try {
      if (existsSync(claudePath)) {
        const content = readFileSync(claudePath, 'utf-8');
        parts.push(`# Agent Identity & Rules\n\n${content}`);
      }
    } catch {
      this.logger.warn({ path: claudePath }, 'Could not read CLAUDE.md');
    }

    // Auto-detect project CLAUDE.md files by walking up from cwd
    const projectClaudeMds = findProjectClaudeMds(process.cwd());
    for (const mdPath of projectClaudeMds) {
      if (mdPath === claudePath) continue;
      try {
        const content = readFileSync(mdPath, 'utf-8');
        parts.push(`# Project Context (${mdPath})\n\n${content}`);
        this.logger.debug({ path: mdPath }, 'Loaded project CLAUDE.md');
      } catch {
        this.logger.warn({ path: mdPath }, 'Could not read project CLAUDE.md');
      }
    }

    // Walk skills directory — store full content privately, only expose stubs in system context
    try {
      if (existsSync(skillsPath)) {
        const entries = readdirSync(skillsPath, { withFileTypes: true });
        for (const entry of entries) {
          let name: string;
          let content: string;

          if (entry.isDirectory()) {
            const skillMd = join(skillsPath, entry.name, 'SKILL.md');
            if (!existsSync(skillMd)) continue;
            name = entry.name;
            content = readFileSync(skillMd, 'utf-8');
          } else if (entry.isFile() && entry.name.endsWith('.md')) {
            name = entry.name.replace('.md', '');
            content = readFileSync(join(skillsPath, entry.name), 'utf-8');
          } else {
            continue;
          }

          this.skillContents.set(name, content);
          skillRaws.push({ name, content });

          // Extract description from frontmatter for system context stub
          const desc = extractFrontmatterDescription(content);
          skillStubs.push(`  /${name}${desc ? ` — ${desc}` : ''}`);
        }
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.warn({ skillsDir: skillsPath, err }, 'Error reading skills directory');
      }
    }

    // Only a compact mention — NOT individual stubs — to keep token count low.
    // The user invokes skills with /skillname. Stubs are surfaced via the recommender, not dumped here.
    if (skillStubs.length > 0) {
      parts.push(
        `# Available Skills\n\n` +
        `${skillStubs.length} skills are available. The user invokes them with /skillname [args]. ` +
        `Do NOT execute any skill behaviour unless the user explicitly types /skillname.\n\n` +
        `Top skills: ${skillStubs.slice(0, 8).map((s) => s.trim()).join(', ')}${skillStubs.length > 8 ? `, … (+${skillStubs.length - 8} more)` : ''}.`,
      );
    }

    this.cachedContext = parts.length > 0 ? parts.join('\n\n---\n\n') : '';
    this.recommender.buildIndex(skillRaws);
    this.logger.info({ count: skillRaws.length }, 'Skills loaded');
  }

  getSystemContext(): string {
    return this.cachedContext ?? '';
  }

  startWatching(): void {
    const skillsPath = expandPath(this.skillsDir);
    const claudePath = expandPath(this.claudeMdPath);
    const projectMds = findProjectClaudeMds(process.cwd()).filter((p) => p !== claudePath);
    const watchPaths = [skillsPath, claudePath, ...projectMds].filter(existsSync);

    if (watchPaths.length === 0) return;

    this.watcher = watch(watchPaths, {
      ignored: [
        '**/.git/**',
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/__pycache__/**',
      ],
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this.watcher.on('all', (_event, changedPath) => {
      this.logger.info({ path: changedPath }, 'Skills changed, reloading');
      this.load()
        .then(() => {
          for (const cb of this.reloadCallbacks) cb();
        })
        .catch((err: unknown) => {
          this.logger.error({ err }, 'Skill reload failed');
        });
    });

    this.watcher.on('error', (err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
        if (!this.hasWarnedENOSPC) {
          this.hasWarnedENOSPC = true;
          this.logger.warn(
            'System file watcher limit reached (ENOSPC). Hot-reloading is disabled for skills. ' +
            'To fix this, run: echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p'
          );
        }
      } else {
        this.logger.warn({ err }, 'Skill watcher error');
      }
    });
  }

  stopWatching(): void {
    this.watcher?.close().catch(() => {/* ignore */});
    this.watcher = null;
  }

  onReload(callback: () => void): void {
    this.reloadCallbacks.push(callback);
  }
}
