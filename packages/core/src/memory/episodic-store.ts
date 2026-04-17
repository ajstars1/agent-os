/**
 * EpisodicStore — what happened, when, and how important it was.
 *
 * Episodes are significant moments extracted from conversations:
 * "You were debugging a Supabase auth bug on Apr 15"
 * "You shipped 0unveiled MVP and were excited about early traction"
 *
 * Decay: importance × e^(−λ × days_elapsed), λ = 0.07 → half-life ≈ 10 days.
 * This means yesterday feels vivid; last month is a faint echo — just like
 * human memory.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const DECAY_LAMBDA = 0.07; // ~10 day half-life
const MS_PER_DAY = 86_400_000;

function expandPath(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

export type EpisodeTone = 'positive' | 'negative' | 'neutral' | 'frustrated' | 'excited';

export interface Episode {
  id: string;
  /** 1-2 sentence human-readable summary of what happened. */
  summary: string;
  /** Topics for retrieval matching (e.g. ['supabase', 'auth', '0unveiled']). */
  topics: string[];
  /** 0.0–1.0. Set at write time. Breakthroughs = 1.0, routine = 0.3. */
  importance: number;
  tone: EpisodeTone;
  /** Unix ms timestamp when this episode occurred. */
  occurredAt: number;
  /** Which conversation this was extracted from. */
  conversationId: string;
  /** Computed score: importance × e^(−λ × days). Higher = more surfaced. */
  decayScore: number;
}

interface EpisodeRow {
  id: string;
  summary: string;
  topics: string;
  importance: number;
  tone: string;
  occurred_at: number;
  conversation_id: string;
}

function computeDecayScore(importance: number, occurredAt: number): number {
  const daysElapsed = (Date.now() - occurredAt) / MS_PER_DAY;
  return importance * Math.exp(-DECAY_LAMBDA * daysElapsed);
}

function rowToEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    summary: row.summary,
    topics: JSON.parse(row.topics) as string[],
    importance: row.importance,
    tone: row.tone as EpisodeTone,
    occurredAt: row.occurred_at,
    conversationId: row.conversation_id,
    decayScore: computeDecayScore(row.importance, row.occurred_at),
  };
}

export class EpisodicStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const isMemory = dbPath === ':memory:';
    if (!isMemory) {
      const resolved = expandPath(dbPath);
      mkdirSync(dirname(resolved), { recursive: true });
      this.db = new Database(resolved);
    } else {
      this.db = new Database(':memory:');
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id              TEXT PRIMARY KEY,
        summary         TEXT NOT NULL,
        topics          TEXT NOT NULL DEFAULT '[]',
        importance      REAL NOT NULL DEFAULT 0.5,
        tone            TEXT NOT NULL DEFAULT 'neutral',
        occurred_at     INTEGER NOT NULL,
        conversation_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ep_occurred ON episodes(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ep_conv     ON episodes(conversation_id);
    `);
  }

  /** Write a new episode. */
  add(episode: Omit<Episode, 'id' | 'decayScore'>): Episode {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO episodes (id, summary, topics, importance, tone, occurred_at, conversation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        episode.summary,
        JSON.stringify(episode.topics),
        episode.importance,
        episode.tone,
        episode.occurredAt,
        episode.conversationId,
      );
    return { ...episode, id, decayScore: computeDecayScore(episode.importance, episode.occurredAt) };
  }

  /**
   * Retrieve top episodes by decay score.
   * If `topics` provided, episodes sharing ≥1 topic get a 2× boost.
   */
  getTopN(n: number, filterTopics?: string[]): Episode[] {
    const rows = this.db
      .prepare<[], EpisodeRow>('SELECT * FROM episodes ORDER BY occurred_at DESC LIMIT 200')
      .all();

    const withScore = rows.map((r) => {
      const ep = rowToEpisode(r);
      const topicBoost =
        filterTopics && filterTopics.some((t) => ep.topics.includes(t)) ? 2 : 1;
      return { ep, score: ep.decayScore * topicBoost };
    });

    return withScore
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map((x) => x.ep);
  }

  /** Get all episodes for a specific conversation. */
  getByConversation(conversationId: string): Episode[] {
    return this.db
      .prepare<[string], EpisodeRow>('SELECT * FROM episodes WHERE conversation_id = ? ORDER BY occurred_at DESC')
      .all(conversationId)
      .map(rowToEpisode);
  }

  /** Total episode count — useful for knowing how rich the memory is. */
  count(): number {
    const row = this.db.prepare<[], { n: number }>('SELECT COUNT(*) as n FROM episodes').get();
    return row?.n ?? 0;
  }

  /** Prune episodes with decay score below threshold (housekeeping). */
  pruneBelow(minScore: number): number {
    const rows = this.db
      .prepare<[], EpisodeRow>('SELECT * FROM episodes')
      .all();

    const toPrune = rows
      .map(rowToEpisode)
      .filter((ep) => ep.decayScore < minScore)
      .map((ep) => ep.id);

    if (toPrune.length === 0) return 0;

    const placeholders = toPrune.map(() => '?').join(', ');
    this.db
      .prepare(`DELETE FROM episodes WHERE id IN (${placeholders})`)
      .run(...toPrune);

    return toPrune.length;
  }

  close(): void {
    this.db.close();
  }
}
