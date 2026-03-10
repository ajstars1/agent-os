import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillLoader } from '../skills/loader.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });
const tmp = () => mkdtempSync(join(tmpdir(), 'agent-os-test-'));

describe('SkillLoader', () => {
  let skillsDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    skillsDir = tmp();
    claudeMdPath = join(tmp(), 'CLAUDE.md');
  });

  afterEach(() => {
    rmSync(skillsDir, { recursive: true, force: true });
    rmSync(dirname(claudeMdPath), { recursive: true, force: true });
  });

  it('loads empty context when dirs do not exist', async () => {
    const loader = new SkillLoader('/nonexistent/skills', '/nonexistent/CLAUDE.md', logger);
    await loader.load();
    expect(loader.getSystemContext()).toBe('');
  });

  it('loads CLAUDE.md content', async () => {
    writeFileSync(claudeMdPath, '# My Rules\nBe helpful.');
    const loader = new SkillLoader('/nonexistent', claudeMdPath, logger);
    await loader.load();
    expect(loader.getSystemContext()).toContain('My Rules');
    expect(loader.getSystemContext()).toContain('Be helpful.');
  });

  it('loads skill .md files from directory', async () => {
    writeFileSync(join(skillsDir, 'coding.md'), '# Coding skill\nWrite clean code.');
    writeFileSync(join(skillsDir, 'design.md'), '# Design skill\nThink visually.');
    const loader = new SkillLoader(skillsDir, '/nonexistent/CLAUDE.md', logger);
    await loader.load();
    const ctx = loader.getSystemContext();
    expect(ctx).toContain('Skill: coding');
    expect(ctx).toContain('Write clean code.');
    expect(ctx).toContain('Skill: design');
  });

  it('loads SKILL.md from subdirectories', async () => {
    const subDir = join(skillsDir, 'typescript');
    mkdirSync(subDir);
    writeFileSync(join(subDir, 'SKILL.md'), '# TypeScript expertise');
    const loader = new SkillLoader(skillsDir, '/nonexistent/CLAUDE.md', logger);
    await loader.load();
    expect(loader.getSystemContext()).toContain('Skill: typescript');
    expect(loader.getSystemContext()).toContain('TypeScript expertise');
  });

  it('reloads context when load() called again', async () => {
    writeFileSync(join(skillsDir, 'a.md'), 'Version 1');
    const loader = new SkillLoader(skillsDir, '/nonexistent/CLAUDE.md', logger);
    await loader.load();
    expect(loader.getSystemContext()).toContain('Version 1');

    writeFileSync(join(skillsDir, 'a.md'), 'Version 2');
    await loader.load();
    expect(loader.getSystemContext()).toContain('Version 2');
  });
});
