import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
function expandPath(p) {
    return p.startsWith('~') ? p.replace('~', homedir()) : p;
}
export class TieredStore {
    db;
    l0Cache = new Map();
    constructor(dbPath) {
        const isMemory = dbPath === ':memory:';
        if (!isMemory) {
            const resolved = expandPath(dbPath);
            mkdirSync(dirname(resolved), { recursive: true });
            this.db = new Database(resolved);
            this.db.pragma('journal_mode = WAL');
        }
        else {
            this.db = new Database(':memory:');
        }
        this.db.pragma('foreign_keys = ON');
        this.migrate();
        this.loadL0Cache();
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id            TEXT PRIMARY KEY,
        topic         TEXT NOT NULL UNIQUE,
        l0            TEXT NOT NULL,
        l1            TEXT NOT NULL,
        l2            TEXT NOT NULL,
        l3            TEXT NOT NULL,
        tags          TEXT NOT NULL DEFAULT '[]',
        last_accessed INTEGER NOT NULL DEFAULT 0,
        access_count  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_topic ON knowledge_chunks(topic);

      CREATE TABLE IF NOT EXISTS compression_cache (
        content_hash TEXT PRIMARY KEY,
        l0           TEXT NOT NULL,
        l1           TEXT NOT NULL,
        l2           TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
    `);
    }
    loadL0Cache() {
        const rows = this.db
            .prepare('SELECT id, topic, l0, tags FROM knowledge_chunks')
            .all();
        this.l0Cache.clear();
        for (const row of rows) {
            let tags = [];
            try {
                tags = JSON.parse(row.tags);
            }
            catch { /* ignore */ }
            this.l0Cache.set(row.topic, { id: row.id, topic: row.topic, l0: row.l0, tags });
        }
    }
    addChunk(chunk) {
        const id = randomUUID();
        const now = Date.now();
        this.db
            .prepare(`INSERT INTO knowledge_chunks (id, topic, l0, l1, l2, l3, tags, last_accessed, access_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(topic) DO UPDATE SET
           l0=excluded.l0, l1=excluded.l1, l2=excluded.l2, l3=excluded.l3,
           tags=excluded.tags, last_accessed=excluded.last_accessed`)
            .run(id, chunk.topic, chunk.L0, chunk.L1, chunk.L2, chunk.L3, JSON.stringify(chunk.tags), now, chunk.accessCount);
        // Refresh L0 cache
        const entry = { id, topic: chunk.topic, l0: chunk.L0, tags: chunk.tags };
        this.l0Cache.set(chunk.topic, entry);
        return { id, ...chunk, lastAccessed: now };
    }
    getChunk(id) {
        const row = this.db
            .prepare('SELECT * FROM knowledge_chunks WHERE id = ?')
            .get(id);
        return row ? this.rowToChunk(row) : null;
    }
    getByTopic(topic) {
        const row = this.db
            .prepare('SELECT * FROM knowledge_chunks WHERE topic = ?')
            .get(topic);
        return row ? this.rowToChunk(row) : null;
    }
    /** Returns L0 cache entries — cheap, in-memory */
    getAllL0() {
        return Array.from(this.l0Cache.values());
    }
    getAtDepth(topic, depth) {
        if (depth === 'L0') {
            return this.l0Cache.get(topic)?.l0 ?? null;
        }
        const row = this.db
            .prepare('SELECT l0, l1, l2, l3 FROM knowledge_chunks WHERE topic = ?')
            .get(topic);
        if (!row)
            return null;
        const colMap = { L0: row.l0, L1: row.l1, L2: row.l2, L3: row.l3 };
        return colMap[depth];
    }
    updateAccessStats(id) {
        const now = Date.now();
        this.db
            .prepare('UPDATE knowledge_chunks SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?')
            .run(now, id);
    }
    // ── compression cache ──────────────────────────────────────────────────────
    getCachedCompression(contentHash) {
        const row = this.db
            .prepare('SELECT l0, l1, l2 FROM compression_cache WHERE content_hash = ?')
            .get(contentHash);
        return row ? { l0: row.l0, l1: row.l1, l2: row.l2 } : null;
    }
    setCachedCompression(contentHash, l0, l1, l2) {
        this.db
            .prepare(`INSERT OR IGNORE INTO compression_cache (content_hash, l0, l1, l2, created_at)
         VALUES (?, ?, ?, ?, ?)`)
            .run(contentHash, l0, l1, l2, new Date().toISOString());
    }
    getAllChunkStats() {
        const rows = this.db
            .prepare('SELECT topic, l0, access_count, last_accessed FROM knowledge_chunks ORDER BY access_count DESC')
            .all();
        return rows.map((r) => ({
            topic: r.topic,
            l0: r.l0,
            accessCount: r.access_count,
            lastAccessed: r.last_accessed,
        }));
    }
    close() {
        this.db.close();
    }
    rowToChunk(row) {
        let tags = [];
        try {
            tags = JSON.parse(row.tags);
        }
        catch { /* ignore */ }
        return {
            id: row.id, topic: row.topic,
            L0: row.l0, L1: row.l1, L2: row.l2, L3: row.l3,
            tags, lastAccessed: row.last_accessed, accessCount: row.access_count,
        };
    }
}
//# sourceMappingURL=tiered-store.js.map