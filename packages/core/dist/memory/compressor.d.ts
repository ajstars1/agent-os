import type { TieredStore, KnowledgeChunk } from './tiered-store.js';
export declare class HAMCompressor {
    private readonly store;
    private readonly genAI;
    constructor(apiKey: string, store: TieredStore);
    /**
     * Compress raw text into all 4 levels.
     * Caches L0/L1/L2 in SQLite — will never re-compress the same content.
     */
    compressChunk(rawText: string, topic: string, tags?: string[]): Promise<Omit<KnowledgeChunk, 'id' | 'lastAccessed' | 'accessCount'>>;
    private compress;
}
//# sourceMappingURL=compressor.d.ts.map