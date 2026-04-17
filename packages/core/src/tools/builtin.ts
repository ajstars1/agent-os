import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, normalize, resolve as resolvePath, relative } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ToolResult, Logger, PermissionCallback } from '@agent-os-core/shared';
import type { ToolRegistry } from './registry.js';
import type { TieredStore } from '../memory/tiered-store.js';
import type { HAMCompressor } from '../memory/compressor.js';

const execAsync = promisify(exec);

const MAX_FETCH_BYTES = 51_200;
const MAX_FILE_BYTES = 65_536;

const FULL_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/home/ubuntu/.local/bin';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build']);

function expandPath(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

function isPathAllowed(resolved: string, allowedDirs: string[]): boolean {
  return allowedDirs.some((dir) => {
    const normalized = normalize(expandPath(dir));
    return resolved.startsWith(normalized + '/') || resolved === normalized;
  });
}

// ─── web_fetch ────────────────────────────────────────────────────────────────

const WebFetchSchema = z.object({
  url: z.string().url(),
  timeoutMs: z.number().int().min(1000).max(30_000).default(10_000),
});

async function handleWebFetch(
  raw: Record<string, unknown>,
  logger: Logger,
): Promise<ToolResult> {
  const parsed = WebFetchSchema.safeParse(raw);
  if (!parsed.success) {
    return { toolCallId: '', content: parsed.error.toString(), isError: true };
  }
  const { url, timeoutMs } = parsed.data;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'agent-os/0.2.0' },
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { toolCallId: '', content: `HTTP ${res.status} ${res.statusText}`, isError: true };
    }

    const text = await res.text();
    const cleaned = text
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_FETCH_BYTES);

    logger.debug({ url, length: cleaned.length }, 'web_fetch complete');
    return { toolCallId: '', content: cleaned, isError: false };
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return { toolCallId: '', content: msg, isError: true };
  }
}

// ─── bash ─────────────────────────────────────────────────────────────────────

const BashSchema = z.object({
  command: z.string().min(1).max(4000),
  timeoutMs: z.number().int().min(1000).max(60_000).default(10_000),
});

async function handleBash(
  raw: Record<string, unknown>,
  logger: Logger,
): Promise<ToolResult> {
  const parsed = BashSchema.safeParse(raw);
  if (!parsed.success) {
    return { toolCallId: '', content: parsed.error.toString(), isError: true };
  }
  const { command, timeoutMs } = parsed.data;

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
      timeout: timeoutMs,
      env: {
        PATH: FULL_PATH,
        HOME: process.env['HOME'] ?? homedir(),
        USER: process.env['USER'] ?? '',
        NODE_ENV: process.env['NODE_ENV'] ?? '',
        ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'] ?? '',
      },
      maxBuffer: 1024 * 1024,
    });
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    logger.debug({ command }, 'bash tool executed');
    return { toolCallId: '', content: output || '(no output)', isError: false };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { toolCallId: '', content: msg, isError: true };
  }
}

// ─── read_file ────────────────────────────────────────────────────────────────

const ReadFileSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().max(512_000).default(MAX_FILE_BYTES),
});

async function handleReadFile(
  raw: Record<string, unknown>,
  logger: Logger,
  allowedDirs: string[],
): Promise<ToolResult> {
  const parsed = ReadFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { toolCallId: '', content: parsed.error.toString(), isError: true };
  }
  const { path: filePath, maxBytes } = parsed.data;
  const resolved = resolvePath(expandPath(filePath));

  if (allowedDirs.length > 0 && !isPathAllowed(resolved, allowedDirs)) {
    return { toolCallId: '', content: `Path not allowed: ${resolved}`, isError: true };
  }

  try {
    const content = await readFile(resolved, 'utf-8');
    const truncated = content.slice(0, maxBytes);
    logger.debug({ path: resolved, length: truncated.length }, 'read_file complete');
    return { toolCallId: '', content: truncated, isError: false };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { toolCallId: '', content: msg, isError: true };
  }
}

// ─── write_file ───────────────────────────────────────────────────────────────

const WriteFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

async function handleWriteFile(
  raw: Record<string, unknown>,
  logger: Logger,
  allowedDirs: string[],
): Promise<ToolResult> {
  const parsed = WriteFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { toolCallId: '', content: parsed.error.toString(), isError: true };
  }
  const { path: filePath, content } = parsed.data;
  const resolved = resolvePath(expandPath(filePath));

  if (allowedDirs.length > 0 && !isPathAllowed(resolved, allowedDirs)) {
    return { toolCallId: '', content: `Path not allowed: ${resolved}`, isError: true };
  }

  try {
    mkdirSync(dirname(resolved), { recursive: true });
    await writeFile(resolved, content, 'utf-8');
    logger.debug({ path: resolved }, 'write_file complete');
    return { toolCallId: '', content: `Written ${content.length} bytes to ${resolved}`, isError: false };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { toolCallId: '', content: msg, isError: true };
  }
}

// ─── glob ─────────────────────────────────────────────────────────────────────

const GlobSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  limit: z.number().int().min(1).max(2000).default(200),
});

function globPatternToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      // ** matches any path including slashes
      regexStr += '.*';
      i += 2;
      // skip optional trailing slash
      if (pattern[i] === '/') i++;
    } else if (pattern[i] === '*') {
      // * matches within segment only
      regexStr += '[^/]*';
      i++;
    } else if (pattern[i] === '?') {
      regexStr += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(pattern[i] as string)) {
      regexStr += '\\' + pattern[i];
      i++;
    } else {
      regexStr += pattern[i];
      i++;
    }
  }
  return new RegExp('^' + regexStr + '$');
}

interface StatEntry {
  path: string;
  mtime: number;
}

async function walkDir(root: string, base: string, regex: RegExp, results: StatEntry[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(base, entry.name);
    const relPath = relative(root, fullPath);

    if (entry.isDirectory()) {
      await walkDir(root, fullPath, regex, results);
    } else if (entry.isFile()) {
      if (regex.test(relPath)) {
        try {
          const s = await stat(fullPath);
          results.push({ path: relPath, mtime: s.mtimeMs });
        } catch {
          results.push({ path: relPath, mtime: 0 });
        }
      }
    }
  }
}

async function handleGlob(
  raw: Record<string, unknown>,
  logger: Logger,
): Promise<ToolResult> {
  const parsed = GlobSchema.safeParse(raw);
  if (!parsed.success) {
    return { toolCallId: '', content: parsed.error.toString(), isError: true };
  }
  const { pattern, limit } = parsed.data;
  const searchRoot = resolvePath(expandPath(parsed.data.path ?? process.cwd()));
  const regex = globPatternToRegex(pattern);
  const results: StatEntry[] = [];

  try {
    await walkDir(searchRoot, searchRoot, regex, results);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { toolCallId: '', content: msg, isError: true };
  }

  results.sort((a, b) => b.mtime - a.mtime);
  const paths = results.slice(0, limit).map((r) => r.path);
  logger.debug({ pattern, count: paths.length }, 'glob complete');

  if (paths.length === 0) {
    return { toolCallId: '', content: '(no matches)', isError: false };
  }
  return { toolCallId: '', content: paths.join('\n'), isError: false };
}

// ─── grep ─────────────────────────────────────────────────────────────────────

const GrepSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).default('files_with_matches'),
  context: z.number().int().min(0).max(10).default(0),
  case_insensitive: z.boolean().default(false),
  limit: z.number().int().min(1).max(5000).default(250),
});

async function collectFiles(base: string, globFilter?: string): Promise<string[]> {
  const globRegex = globFilter ? globPatternToRegex(globFilter) : null;
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (!globRegex || globRegex.test(entry.name)) {
          files.push(fullPath);
        }
      }
    }
  }

  await walk(base);
  return files;
}

async function handleGrep(
  raw: Record<string, unknown>,
  logger: Logger,
): Promise<ToolResult> {
  const parsed = GrepSchema.safeParse(raw);
  if (!parsed.success) {
    return { toolCallId: '', content: parsed.error.toString(), isError: true };
  }
  const { pattern, output_mode, context: ctxLines, case_insensitive, limit } = parsed.data;
  const searchRoot = resolvePath(expandPath(parsed.data.path ?? process.cwd()));

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, case_insensitive ? 'i' : '');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { toolCallId: '', content: `Invalid regex: ${msg}`, isError: true };
  }

  const files = await collectFiles(searchRoot, parsed.data.glob);
  const outputLines: string[] = [];
  let totalCount = 0;
  let resultCount = 0;

  for (const filePath of files) {
    if (resultCount >= limit) break;

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    const matchingLineNums: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i] as string)) {
        matchingLineNums.push(i);
      }
    }

    if (matchingLineNums.length === 0) continue;

    const relPath = relative(searchRoot, filePath);
    totalCount += matchingLineNums.length;

    if (output_mode === 'files_with_matches') {
      outputLines.push(relPath);
      resultCount++;
    } else if (output_mode === 'count') {
      outputLines.push(`${relPath}: ${matchingLineNums.length}`);
      resultCount++;
    } else {
      // content mode
      const shown = new Set<number>();
      for (const lineNum of matchingLineNums) {
        const start = Math.max(0, lineNum - ctxLines);
        const end = Math.min(lines.length - 1, lineNum + ctxLines);
        for (let j = start; j <= end; j++) shown.add(j);
      }

      const sortedShown = Array.from(shown).sort((a, b) => a - b);
      let prevLine = -1;
      for (const lineIdx of sortedShown) {
        if (prevLine !== -1 && lineIdx > prevLine + 1) {
          outputLines.push('--');
        }
        const marker = matchingLineNums.includes(lineIdx) ? ':' : '-';
        outputLines.push(`${relPath}:${lineIdx + 1}${marker}${lines[lineIdx]}`);
        prevLine = lineIdx;
        resultCount++;
        if (resultCount >= limit) break;
      }
    }
  }

  logger.debug({ pattern, count: totalCount }, 'grep complete');

  if (outputLines.length === 0) {
    return { toolCallId: '', content: '(no matches)', isError: false };
  }
  return { toolCallId: '', content: outputLines.join('\n'), isError: false };
}

// ─── edit ─────────────────────────────────────────────────────────────────────

const EditSchema = z.object({
  file_path: z.string().min(1),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().default(false),
});

async function handleEdit(
  raw: Record<string, unknown>,
  logger: Logger,
  allowedDirs: string[],
): Promise<ToolResult> {
  const parsed = EditSchema.safeParse(raw);
  if (!parsed.success) {
    return { toolCallId: '', content: parsed.error.toString(), isError: true };
  }
  const { file_path, old_string, new_string, replace_all } = parsed.data;
  const resolved = resolvePath(expandPath(file_path));

  if (allowedDirs.length > 0 && !isPathAllowed(resolved, allowedDirs)) {
    return { toolCallId: '', content: `Path not allowed: ${resolved}`, isError: true };
  }

  let content: string;
  try {
    content = await readFile(resolved, 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { toolCallId: '', content: msg, isError: true };
  }

  // Count occurrences
  let count = 0;
  let idx = content.indexOf(old_string);
  while (idx !== -1) {
    count++;
    idx = content.indexOf(old_string, idx + 1);
  }

  if (count === 0) {
    return { toolCallId: '', content: `old_string not found in ${resolved}`, isError: true };
  }

  if (!replace_all && count > 1) {
    return {
      toolCallId: '',
      content: `old_string appears ${count} times in ${resolved} — use replace_all: true or provide more context`,
      isError: true,
    };
  }

  let updated: string;
  if (replace_all) {
    updated = content.split(old_string).join(new_string);
  } else {
    updated = content.replace(old_string, new_string);
  }

  try {
    await writeFile(resolved, updated, 'utf-8');
    logger.debug({ path: resolved, count }, 'edit complete');
    return { toolCallId: '', content: `Replaced ${count} occurrence${count === 1 ? '' : 's'} in ${resolved}`, isError: false };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { toolCallId: '', content: msg, isError: true };
  }
}

// ─── ls ───────────────────────────────────────────────────────────────────────

const LsSchema = z.object({
  path: z.string().optional(),
  show_hidden: z.boolean().default(false),
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function handleLs(
  raw: Record<string, unknown>,
  logger: Logger,
): Promise<ToolResult> {
  const parsed = LsSchema.safeParse(raw);
  if (!parsed.success) {
    return { toolCallId: '', content: parsed.error.toString(), isError: true };
  }
  const { show_hidden } = parsed.data;
  const dirPath = resolvePath(expandPath(parsed.data.path ?? process.cwd()));

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { toolCallId: '', content: msg, isError: true };
  }

  const filtered = entries.filter((e) => show_hidden || !e.name.startsWith('.'));

  const dirs: string[] = [];
  const files: string[] = [];

  for (const entry of filtered) {
    const fullPath = join(dirPath, entry.name);
    let size = 0;
    let mtime = new Date(0);
    try {
      const s = await stat(fullPath);
      size = s.size;
      mtime = s.mtime;
    } catch {
      // ignore
    }

    const dateStr = formatDate(mtime);
    const sizeStr = formatBytes(size).padStart(8);

    if (entry.isDirectory()) {
      dirs.push(`d  ${sizeStr}  ${dateStr}  ${entry.name}/`);
    } else {
      files.push(`f  ${sizeStr}  ${dateStr}  ${entry.name}`);
    }
  }

  dirs.sort();
  files.sort();

  const lines = [...dirs, ...files];
  logger.debug({ path: dirPath, count: lines.length }, 'ls complete');

  if (lines.length === 0) {
    return { toolCallId: '', content: '(empty directory)', isError: false };
  }
  return { toolCallId: '', content: lines.join('\n'), isError: false };
}

// ─── remember ────────────────────────────────────────────────────────────────

const RememberSchema = z.object({
  topic: z.string().min(1),
  content: z.string().min(1),
});

async function handleRemember(
  raw: Record<string, unknown>,
  logger: Logger,
  hamStore?: TieredStore,
  hamCompressor?: HAMCompressor,
): Promise<ToolResult> {
  if (!hamStore || !hamCompressor) {
    return { toolCallId: '', content: 'HAM memory not configured', isError: true };
  }

  const parsed = RememberSchema.safeParse(raw);
  if (!parsed.success) {
    return { toolCallId: '', content: parsed.error.toString(), isError: true };
  }
  const { topic, content } = parsed.data;

  try {
    const compressed = await hamCompressor.compressChunk(content, topic);
    hamStore.addChunk({ ...compressed, lastAccessed: Date.now(), accessCount: 0 });
    logger.debug({ topic }, 'remember stored');
    return { toolCallId: '', content: `Stored: ${topic} — ${compressed.L0}`, isError: false };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { toolCallId: '', content: msg, isError: true };
  }
}

// ─── Diff preview helper ──────────────────────────────────────────────────────

function buildEditPreview(filePath: string, oldString: string, newString: string): string {
  const lines: string[] = [`Edit: ${filePath}`, ''];
  const removed = oldString.split('\n').slice(0, 6);
  const added = newString.split('\n').slice(0, 6);
  for (const line of removed) lines.push(`- ${line}`);
  for (const line of added) lines.push(`+ ${line}`);
  if (oldString.split('\n').length > 6 || newString.split('\n').length > 6) {
    lines.push('  … (truncated)');
  }
  return lines.join('\n');
}

// ─── Session-level permission state ──────────────────────────────────────────

const SESSION_ALWAYS_ALLOW = new Set<string>();

/**
 * Mutable permission callback — set at runtime by the CLI app after it has a
 * UI context. Defaults to undefined (auto-allow when no UI is attached).
 */
let _permissionCallback: PermissionCallback | undefined;

/** Set or clear the active permission callback (call from CLI App on mount). */
export function setPermissionCallback(cb: PermissionCallback | undefined): void {
  _permissionCallback = cb;
  SESSION_ALWAYS_ALLOW.clear();
}

async function checkPermission(
  toolName: string,
  input: Record<string, unknown>,
  preview: string,
): Promise<boolean> {
  if (!_permissionCallback) return true;
  if (SESSION_ALWAYS_ALLOW.has(toolName)) return true;

  const decision = await _permissionCallback(toolName, { ...input, _preview: preview });
  if (decision === 'always') {
    SESSION_ALWAYS_ALLOW.add(toolName);
    return true;
  }
  return decision === 'allow';
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerBuiltinTools(
  registry: ToolRegistry,
  logger: Logger,
  allowedDirs: string[] = [],
  hamStore?: TieredStore,
  hamCompressor?: HAMCompressor,
): void {
  registry.register(
    {
      name: 'web_fetch',
      description:
        'Fetch the text content of a URL. Returns plain text with HTML stripped. Max 50KB.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
          timeoutMs: { type: 'number', description: 'Request timeout in milliseconds', default: 10000 },
        },
        required: ['url'],
      },
    },
    (input) => handleWebFetch(input, logger),
  );

  registry.register(
    {
      name: 'bash',
      description:
        'Run a shell command in the current working directory with full PATH. Returns stdout and stderr combined.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          timeoutMs: { type: 'number', description: 'Execution timeout in milliseconds', default: 10000 },
        },
        required: ['command'],
      },
    },
    async (input) => {
      const command = typeof input['command'] === 'string' ? input['command'] : '';
      const allowed = await checkPermission('bash', input, `$ ${command}`);
      if (!allowed) return { toolCallId: '', content: 'Permission denied by user.', isError: true };
      return handleBash(input, logger);
    },
  );

  registry.register(
    {
      name: 'read_file',
      description: 'Read a file from the local filesystem. Returns UTF-8 text content.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or ~ path to the file' },
          maxBytes: { type: 'number', description: 'Max bytes to read (default 65536)', default: 65536 },
        },
        required: ['path'],
      },
    },
    (input) => handleReadFile(input, logger, allowedDirs),
  );

  registry.register(
    {
      name: 'write_file',
      description: 'Write text content to a file. Creates parent directories if needed.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or ~ path to write to' },
          content: { type: 'string', description: 'Text content to write' },
        },
        required: ['path', 'content'],
      },
    },
    async (input) => {
      const path = typeof input['path'] === 'string' ? input['path'] : '';
      const content = typeof input['content'] === 'string' ? input['content'] : '';
      const preview = `Write ${content.split('\n').length} lines to ${path}`;
      const allowed = await checkPermission('write_file', input, preview);
      if (!allowed) return { toolCallId: '', content: 'Permission denied by user.', isError: true };
      return handleWriteFile(input, logger, allowedDirs);
    },
  );

  registry.register(
    {
      name: 'glob',
      description:
        'Find files matching a glob pattern. Skips node_modules, .git, dist, .next, build. Returns paths sorted by mtime.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern like "**/*.ts" or "src/**/*.tsx"' },
          path: { type: 'string', description: 'Root directory to search (defaults to cwd)' },
          limit: { type: 'number', description: 'Max results (default 200)', default: 200 },
        },
        required: ['pattern'],
      },
    },
    (input) => handleGlob(input, logger),
  );

  registry.register(
    {
      name: 'grep',
      description:
        'Search file contents with a regex pattern. Skips node_modules, .git, dist, .next, build.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Root directory to search (defaults to cwd)' },
          glob: { type: 'string', description: 'File glob filter e.g. "*.ts"' },
          output_mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description: 'Output format (default: files_with_matches)',
            default: 'files_with_matches',
          },
          context: { type: 'number', description: 'Lines of context around matches', default: 0 },
          case_insensitive: { type: 'boolean', description: 'Case-insensitive search', default: false },
          limit: { type: 'number', description: 'Max results (default 250)', default: 250 },
        },
        required: ['pattern'],
      },
    },
    (input) => handleGrep(input, logger),
  );

  registry.register(
    {
      name: 'edit',
      description:
        'Precise string replacement in a file. Errors if old_string is ambiguous (appears more than once) unless replace_all is set.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or ~ path to the file' },
          old_string: { type: 'string', description: 'Exact string to find and replace' },
          new_string: { type: 'string', description: 'Replacement string' },
          replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)', default: false },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
    async (input) => {
      const filePath = typeof input['file_path'] === 'string' ? input['file_path'] : '';
      const oldStr = typeof input['old_string'] === 'string' ? input['old_string'] : '';
      const newStr = typeof input['new_string'] === 'string' ? input['new_string'] : '';
      const preview = buildEditPreview(filePath, oldStr, newStr);
      const allowed = await checkPermission('edit', input, preview);
      if (!allowed) return { toolCallId: '', content: 'Permission denied by user.', isError: true };
      return handleEdit(input, logger, allowedDirs);
    },
  );

  registry.register(
    {
      name: 'ls',
      description: 'List directory contents with sizes and modification times. Dirs shown first.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to list (defaults to cwd)' },
          show_hidden: { type: 'boolean', description: 'Include hidden files (default false)', default: false },
        },
        required: [],
      },
    },
    (input) => handleLs(input, logger),
  );

  registry.register(
    {
      name: 'remember',
      description:
        'Store knowledge directly to HAM memory with hierarchical compression. Use for facts, decisions, or context worth remembering long-term.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Topic/key for this knowledge' },
          content: { type: 'string', description: 'The knowledge content to compress and store' },
        },
        required: ['topic', 'content'],
      },
    },
    (input) => handleRemember(input, logger, hamStore, hamCompressor),
  );
}
