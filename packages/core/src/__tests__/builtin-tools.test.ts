import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/builtin.js';

const logger = pino({ level: 'silent' });

function makeRegistry(allowedDirs: string[] = []): ToolRegistry {
  const registry = new ToolRegistry(logger);
  registerBuiltinTools(registry, logger, allowedDirs);
  return registry;
}

describe('builtin: bash', () => {
  it('executes a simple command and returns stdout', async () => {
    const registry = makeRegistry();
    const result = await registry.callTool('bash', { command: 'echo hello' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('hello');
  });

  it('returns isError=true for non-zero exit', async () => {
    const registry = makeRegistry();
    const result = await registry.callTool('bash', { command: 'exit 1' });
    expect(result.isError).toBe(true);
  });

  it('returns isError=true for invalid input', async () => {
    const registry = makeRegistry();
    const result = await registry.callTool('bash', { command: 123 });
    expect(result.isError).toBe(true);
  });
});

describe('builtin: read_file', () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('blocks access outside allowedDirs', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-test-'));
    const registry = makeRegistry(['/some/other/dir']);
    const result = await registry.callTool('read_file', { path: join(tmpDir, 'file.txt') });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not allowed');
  });

  it('reads file within allowedDirs', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-test-'));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(tmpDir, 'test.txt'), 'hello world');

    const registry = makeRegistry([tmpDir]);
    const result = await registry.callTool('read_file', { path: join(tmpDir, 'test.txt') });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('1 | hello world');
  });

  it('allows all paths when allowedDirs is empty', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-test-'));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(tmpDir, 'open.txt'), 'open content');

    const registry = makeRegistry([]);
    const result = await registry.callTool('read_file', { path: join(tmpDir, 'open.txt') });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('1 | open content');
  });
});

describe('builtin: web_fetch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns isError=true for invalid URL', async () => {
    const registry = makeRegistry();
    const result = await registry.callTool('web_fetch', { url: 'not-a-url' });
    expect(result.isError).toBe(true);
  });

  it('strips HTML tags from fetched content', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<html><body><p>Hello <strong>world</strong></p></body></html>',
    });
    vi.stubGlobal('fetch', mockFetch);

    const registry = makeRegistry();
    const result = await registry.callTool('web_fetch', { url: 'https://example.com' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Hello');
    expect(result.content).toContain('world');
    expect(result.content).not.toContain('<p>');
  });

  it('returns isError=true on HTTP error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }));
    const registry = makeRegistry();
    const result = await registry.callTool('web_fetch', { url: 'https://example.com/missing' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('404');
  });
});

describe('builtin: write_file', () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes file within allowedDirs', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-write-test-'));
    const registry = makeRegistry([tmpDir]);
    const filePath = join(tmpDir, 'out.txt');
    const result = await registry.callTool('write_file', { path: filePath, content: 'written!' });
    expect(result.isError).toBe(false);

    const { readFileSync } = await import('node:fs');
    expect(readFileSync(filePath, 'utf-8')).toBe('written!');
  });

  it('blocks writes outside allowedDirs', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-write-test-'));
    const registry = makeRegistry(['/safe/dir']);
    const result = await registry.callTool('write_file', { path: join(tmpDir, 'out.txt'), content: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not allowed');
  });
});

describe('ToolRegistry.register', () => {
  it('inline handler takes priority over MCP', async () => {
    const registry = makeRegistry();
    let called = false;
    registry.register(
      { name: 'custom_tool', description: 'test', inputSchema: {} },
      async (_input) => {
        called = true;
        return { toolCallId: '', content: 'custom result', isError: false };
      },
    );
    const result = await registry.callTool('custom_tool', {});
    expect(called).toBe(true);
    expect(result.content).toBe('custom result');
  });

  it('getTools includes registered builtin tools', () => {
    const registry = makeRegistry();
    const names = registry.getTools().map((t) => t.name);
    expect(names).toContain('bash');
    expect(names).toContain('web_fetch');
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
  });
});
