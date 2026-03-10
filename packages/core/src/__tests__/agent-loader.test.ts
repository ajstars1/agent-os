import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentLoader } from '../agents/loader.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('AgentLoader', () => {
  let agentsDir: string;

  beforeEach(() => {
    agentsDir = mkdtempSync(join(tmpdir(), 'agent-os-agents-'));
  });

  afterEach(() => {
    rmSync(agentsDir, { recursive: true, force: true });
  });

  it('returns undefined for unknown agent', async () => {
    const loader = new AgentLoader(agentsDir, logger);
    await loader.load();
    expect(loader.get('unknown')).toBeUndefined();
  });

  it('loads a valid agent profile from JSON file', async () => {
    writeFileSync(
      join(agentsDir, 'coder.json'),
      JSON.stringify({
        name: 'coder',
        systemPrompt: 'You are an expert programmer.',
        defaultModel: 'claude',
        skills: ['typescript'],
      }),
    );
    const loader = new AgentLoader(agentsDir, logger);
    await loader.load();

    const profile = loader.get('coder');
    expect(profile).toBeTruthy();
    expect(profile?.systemPrompt).toBe('You are an expert programmer.');
    expect(profile?.defaultModel).toBe('claude');
    expect(profile?.skills).toEqual(['typescript']);
  });

  it('skips invalid agent profile with bad name format', async () => {
    writeFileSync(
      join(agentsDir, 'bad.json'),
      JSON.stringify({ name: 'INVALID NAME!', defaultModel: 'claude' }),
    );
    const loader = new AgentLoader(agentsDir, logger);
    await loader.load();
    expect(loader.list()).toHaveLength(0);
  });

  it('skips non-JSON files', async () => {
    writeFileSync(join(agentsDir, 'readme.txt'), 'not json');
    const loader = new AgentLoader(agentsDir, logger);
    await loader.load();
    expect(loader.list()).toHaveLength(0);
  });

  it('loads multiple agents', async () => {
    writeFileSync(join(agentsDir, 'coder.json'), JSON.stringify({ name: 'coder', defaultModel: 'claude' }));
    writeFileSync(join(agentsDir, 'writer.json'), JSON.stringify({ name: 'writer', defaultModel: 'gemini' }));
    const loader = new AgentLoader(agentsDir, logger);
    await loader.load();
    expect(loader.list()).toHaveLength(2);
  });

  it('registerInline adds a profile without file IO', async () => {
    const loader = new AgentLoader(agentsDir, logger);
    await loader.load();
    loader.registerInline({ name: 'inline-agent', defaultModel: 'claude', skills: [] });
    expect(loader.get('inline-agent')).toBeTruthy();
  });

  it('handles missing agents directory gracefully', async () => {
    const loader = new AgentLoader('/nonexistent/agents', logger);
    await expect(loader.load()).resolves.not.toThrow();
    expect(loader.list()).toHaveLength(0);
  });
});
