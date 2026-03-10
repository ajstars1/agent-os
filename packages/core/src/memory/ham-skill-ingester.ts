import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Logger } from '@agent-os/shared';
import type { TieredStore } from './tiered-store.js';
import type { HAMCompressor } from './compressor.js';

function expandPath(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

/**
 * Read all SKILL.md files from skillsDir and ingest into HAM.
 * Skips skills already present (topic match). Compresses via Gemini Flash.
 */
export async function ingestSkillsToHAM(
  skillsDir: string,
  store: TieredStore,
  compressor: HAMCompressor,
  logger: Logger,
): Promise<void> {
  const dir = expandPath(skillsDir);
  if (!existsSync(dir)) {
    logger.info({ skillsDir: dir }, 'Skills dir not found — skipping HAM ingestion');
    return;
  }

  const existingTopics = new Set(store.getAllL0().map((e) => e.topic));
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    let skillName: string;
    let rawContent: string;

    if (entry.isDirectory()) {
      const skillMd = join(dir, entry.name, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      skillName = entry.name;
      rawContent = readFileSync(skillMd, 'utf-8');
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      skillName = entry.name.replace(/\.md$/, '');
      rawContent = readFileSync(join(dir, entry.name), 'utf-8');
    } else {
      continue;
    }

    if (existingTopics.has(skillName)) {
      logger.debug({ skill: skillName }, 'Skill already in HAM — skipping');
      continue;
    }

    try {
      logger.info({ skill: skillName }, 'Compressing skill into HAM');
      // Derive tags from first heading words in the file
      const headingMatch = rawContent.match(/^#+\s+(.+)$/m);
      const tags = headingMatch
        ? headingMatch[1].toLowerCase().split(/\s+/).filter((w) => w.length > 3)
        : [skillName];

      const compressed = await compressor.compressChunk(rawContent, skillName, tags);
      store.addChunk({ ...compressed, lastAccessed: Date.now(), accessCount: 0 });
      logger.info({ skill: skillName }, 'Skill ingested into HAM');
    } catch (err: unknown) {
      logger.warn({ err, skill: skillName }, 'Failed to ingest skill into HAM');
    }
  }
}
