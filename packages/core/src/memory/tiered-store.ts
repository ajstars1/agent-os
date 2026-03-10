import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

function expandPath(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

export interface KnowledgeChunk {
  id: string;
  topic: string;
  L0: string;   // 5–10 tokens — headline
  L1: string;   // 20–50 tokens — summary
  L2: string;   // 100–200 tokens — detail
  L3: string;   // 500+ tokens — raw/full
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

interface ChunkRow {
  id: string;
  topic: string;
  l0: string;
  l1: string;
  l2: string;
  l3: string;
  tags: string;
  last_accessed: number;
  access_count: number;
}

interface CompressionCacheRow {
  content_hash: string;
  l0: string;
  l1: string;
  l2: string;
  created_at: string;
}

export class TieredStore {
  readonly db: Database.Database;
  private l0Cache: Map<string, L0Entry> = new Map();

  constructor(dbPath: string) {
    const isMemory = dbPath === ':memory:';
    if (!isMemory) {
      const resolved = expandPath(dbPath);
      mkdirSync(dirname(resolved), { recursive: true });
      this.db = new Database(resolved);
      this.db.pragma('journal_mode = WAL');
    } else {
      this.db = new Database(':memory:');
    }
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.loadL0Cache();
  }

  private migrate(): void {
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

  private loadL0Cache(): void {
    const rows = this.db
      .prepare<[], Pick<ChunkRow, 'id' | 'topic' | 'l0' | 'tags'>>(
        'SELECT id, topic, l0, tags FROM knowledge_chunks',
      )
      .all();

    this.l0Cache.clear();
    for (const row of rows) {
      let tags: string[] = [];
      try { tags = JSON.parse(row.tags) as string[]; } catch { /* ignore */ }
      this.l0Cache.set(row.topic, { id: row.id, topic: row.topic, l0: row.l0, tags });
    }
  }

  addChunk(chunk: Omit<KnowledgeChunk, 'id'>): KnowledgeChunk {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO knowledge_chunks (id, topic, l0, l1, l2, l3, tags, last_accessed, access_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(topic) DO UPDATE SET
           l0=excluded.l0, l1=excluded.l1, l2=excluded.l2, l3=excluded.l3,
           tags=excluded.tags, last_accessed=excluded.last_accessed`,
      )
      .run(
        id, chunk.topic, chunk.L0, chunk.L1, chunk.L2, chunk.L3,
        JSON.stringify(chunk.tags), now, chunk.accessCount,
      );

    // Refresh L0 cache
    const entry: L0Entry = { id, topic: chunk.topic, l0: chunk.L0, tags: chunk.tags };
    this.l0Cache.set(chunk.topic, entry);

    return { id, ...chunk, lastAccessed: now };
  }

  getChunk(id: string): KnowledgeChunk | null {
    const row = this.db
      .prepare<[string], ChunkRow>('SELECT * FROM knowledge_chunks WHERE id = ?')
      .get(id);
    return row ? this.rowToChunk(row) : null;
  }

  getByTopic(topic: string): KnowledgeChunk | null {
    const row = this.db
      .prepare<[string], ChunkRow>('SELECT * FROM knowledge_chunks WHERE topic = ?')
      .get(topic);
    return row ? this.rowToChunk(row) : null;
  }

  /** Returns L0 cache entries — cheap, in-memory */
  getAllL0(): L0Entry[] {
    return Array.from(this.l0Cache.values());
  }

  getAtDepth(topic: string, depth: 'L0' | 'L1' | 'L2' | 'L3'): string | null {
    if (depth === 'L0') {
      return this.l0Cache.get(topic)?.l0 ?? null;
    }
    const row = this.db
      .prepare<[string], Pick<ChunkRow, 'l0' | 'l1' | 'l2' | 'l3'>>(
        'SELECT l0, l1, l2, l3 FROM knowledge_chunks WHERE topic = ?',
      )
      .get(topic);
    if (!row) return null;
    const colMap = { L0: row.l0, L1: row.l1, L2: row.l2, L3: row.l3 };
    return colMap[depth];
  }

  updateAccessStats(id: string): void {
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE knowledge_chunks SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?',
      )
      .run(now, id);
  }

  // ── compression cache ──────────────────────────────────────────────────────

  getCachedCompression(contentHash: string): { l0: string; l1: string; l2: string } | null {
    const row = this.db
      .prepare<[string], CompressionCacheRow>(
        'SELECT l0, l1, l2 FROM compression_cache WHERE content_hash = ?',
      )
      .get(contentHash);
    return row ? { l0: row.l0, l1: row.l1, l2: row.l2 } : null;
  }

  setCachedCompression(contentHash: string, l0: string, l1: string, l2: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO compression_cache (content_hash, l0, l1, l2, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(contentHash, l0, l1, l2, new Date().toISOString());
  }

  getAllChunkStats(): Array<{ topic: string; l0: string; accessCount: number; lastAccessed: number }> {
    const rows = this.db
      .prepare<[], Pick<ChunkRow, 'topic' | 'l0' | 'access_count' | 'last_accessed'>>(
        'SELECT topic, l0, access_count, last_accessed FROM knowledge_chunks ORDER BY access_count DESC',
      )
      .all();
    return rows.map((r) => ({
      topic: r.topic,
      l0: r.l0,
      accessCount: r.access_count,
      lastAccessed: r.last_accessed,
    }));
  }

  close(): void {
    this.db.close();
  }

  private rowToChunk(row: ChunkRow): KnowledgeChunk {
    let tags: string[] = [];
    try { tags = JSON.parse(row.tags) as string[]; } catch { /* ignore */ }
    return {
      id: row.id, topic: row.topic,
      L0: row.l0, L1: row.l1, L2: row.l2, L3: row.l3,
      tags, lastAccessed: row.last_accessed, accessCount: row.access_count,
    };
  }
}
