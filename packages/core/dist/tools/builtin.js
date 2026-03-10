import { readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, normalize, resolve as resolvePath } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
const execAsync = promisify(exec);
const MAX_FETCH_BYTES = 51_200;
const MAX_FILE_BYTES = 65_536;
function expandPath(p) {
    return p.startsWith('~') ? p.replace('~', homedir()) : p;
}
function isPathAllowed(resolved, allowedDirs) {
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
async function handleWebFetch(raw, logger) {
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
    }
    catch (err) {
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
async function handleBash(raw, logger) {
    const parsed = BashSchema.safeParse(raw);
    if (!parsed.success) {
        return { toolCallId: '', content: parsed.error.toString(), isError: true };
    }
    const { command, timeoutMs } = parsed.data;
    const sandboxDir = await mkdtemp(join(tmpdir(), 'agent-os-bash-'));
    try {
        const { stdout, stderr } = await execAsync(command, {
            cwd: sandboxDir,
            timeout: timeoutMs,
            env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
            maxBuffer: 1024 * 1024,
        });
        const output = [stdout, stderr].filter(Boolean).join('\n').trim();
        logger.debug({ command }, 'bash tool executed');
        return { toolCallId: '', content: output || '(no output)', isError: false };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { toolCallId: '', content: msg, isError: true };
    }
    finally {
        await rm(sandboxDir, { recursive: true, force: true });
    }
}
// ─── read_file ────────────────────────────────────────────────────────────────
const ReadFileSchema = z.object({
    path: z.string().min(1),
    maxBytes: z.number().int().max(512_000).default(MAX_FILE_BYTES),
});
async function handleReadFile(raw, logger, allowedDirs) {
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
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { toolCallId: '', content: msg, isError: true };
    }
}
// ─── write_file ───────────────────────────────────────────────────────────────
const WriteFileSchema = z.object({
    path: z.string().min(1),
    content: z.string(),
});
async function handleWriteFile(raw, logger, allowedDirs) {
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
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { toolCallId: '', content: msg, isError: true };
    }
}
// ─── Registration ─────────────────────────────────────────────────────────────
export function registerBuiltinTools(registry, logger, allowedDirs = []) {
    registry.register({
        name: 'web_fetch',
        description: 'Fetch the text content of a URL. Returns plain text with HTML stripped. Max 50KB.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The URL to fetch' },
                timeoutMs: { type: 'number', description: 'Request timeout in milliseconds', default: 10000 },
            },
            required: ['url'],
        },
    }, (input) => handleWebFetch(input, logger));
    registry.register({
        name: 'bash',
        description: 'Run a shell command in a sandboxed temp directory. Returns stdout and stderr combined.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to execute' },
                timeoutMs: { type: 'number', description: 'Execution timeout in milliseconds', default: 10000 },
            },
            required: ['command'],
        },
    }, (input) => handleBash(input, logger));
    registry.register({
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
    }, (input) => handleReadFile(input, logger, allowedDirs));
    registry.register({
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
    }, (input) => handleWriteFile(input, logger, allowedDirs));
}
//# sourceMappingURL=builtin.js.map