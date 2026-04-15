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

  it('loads no skills when dirs do not exist', async () => {
    const loader = new SkillLoader('/nonexistent/skills', '/nonexistent/CLAUDE.md', logger);
    await loader.load();
    // Context may include auto-detected project CLAUDE.md from cwd walk-up,
    // but should not contain any skills (no # Skill: lines)
    const ctx = loader.getSystemContext();
    expect(ctx).not.toContain('# Skill:');
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
    // Full skill content is private — access via getSkillContent() and getSkillNames()
    expect(loader.getSkillNames()).toContain('coding');
    expect(loader.getSkillNames()).toContain('design');
    expect(loader.getSkillContent('coding')).toContain('Write clean code.');
    // System context only includes a compact stub line, not the full content
    expect(loader.getSystemContext()).toContain('/coding');
  });

  it('loads SKILL.md from subdirectories', async () => {
    const subDir = join(skillsDir, 'typescript');
    mkdirSync(subDir);
    writeFileSync(join(subDir, 'SKILL.md'), '# TypeScript expertise');
    const loader = new SkillLoader(skillsDir, '/nonexistent/CLAUDE.md', logger);
    await loader.load();
    expect(loader.getSkillNames()).toContain('typescript');
    expect(loader.getSkillContent('typescript')).toContain('TypeScript expertise');
    expect(loader.getSystemContext()).toContain('/typescript');
  });

  it('reloads context when load() called again', async () => {
    writeFileSync(join(skillsDir, 'a.md'), 'Version 1');
    const loader = new SkillLoader(skillsDir, '/nonexistent/CLAUDE.md', logger);
    await loader.load();
    expect(loader.getSkillContent('a')).toContain('Version 1');

    writeFileSync(join(skillsDir, 'a.md'), 'Version 2');
    await loader.load();
    expect(loader.getSkillContent('a')).toContain('Version 2');
  });
});
