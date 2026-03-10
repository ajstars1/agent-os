import Database from 'better-sqlite3';
export interface KnowledgeChunk {
    id: string;
    topic: string;
    L0: string;
    L1: string;
    L2: string;
    L3: string;
    tags: string[];
    lastAccessed: number;
    accessCount: number;
}
export interface L0Entry {
    id: string;
    topic: string;
    l0: string;
    tags: string[];
}
export declare class TieredStore {
    readonly db: Database.Database;
    private l0Cache;
    constructor(dbPath: string);
    private migrate;
    private loadL0Cache;
    addChunk(chunk: Omit<KnowledgeChunk, 'id'>): KnowledgeChunk;
    getChunk(id: string): KnowledgeChunk | null;
    getByTopic(topic: string): KnowledgeChunk | null;
    /** Returns L0 cache entries — cheap, in-memory */
    getAllL0(): L0Entry[];
    getAtDepth(topic: string, depth: 'L0' | 'L1' | 'L2' | 'L3'): string | null;
    updateAccessStats(id: string): void;
    getCachedCompression(contentHash: string): {
        l0: string;
        l1: string;
        l2: string;
    } | null;
    setCachedCompression(contentHash: string, l0: string, l1: string, l2: string): void;
    getAllChunkStats(): Array<{
        topic: string;
        l0: string;
        accessCount: number;
        lastAccessed: number;
    }>;
    close(): void;
    private rowToChunk;
}
//# sourceMappingURL=tiered-store.d.ts.map