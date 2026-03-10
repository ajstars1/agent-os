import type { Logger } from '@agent-os/shared';
import type { TieredStore } from './tiered-store.js';
import type { HAMCompressor } from './compressor.js';
/**
 * Read all SKILL.md files from skillsDir and ingest into HAM.
 * Skips skills already present (topic match). Compresses via Gemini Flash.
 */
export declare function ingestSkillsToHAM(skillsDir: string, store: TieredStore, compressor: HAMCompressor, logger: Logger): Promise<void>;
//# sourceMappingURL=ham-skill-ingester.d.ts.map