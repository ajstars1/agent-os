/**
 * LearnerClient — reads predictions and hot topics from the background learner.
 *
 * The Python BackgroundLearner writes to companion.db (interest_map,
 * predictions, topic_graph tables). This client reads those tables directly
 * via SQLite — no HTTP round-trip, no LLM calls.
 *
 * On bootstrap, the engine calls warmup() to:
 *   1. Get today's predicted topics
 *   2. Get the current interest map (hot topics)
 *   3. Return them so HAM retrieval and context assembly can use them
 *
 * This is what gives AgentOS its "Jarvis already knows what you need"
 * quality — by the time you open a chat, the relevant context is pre-loaded.
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Prediction {
  topic: string;
  confidence: number;
  source: 'interest' | 'cooccurrence' | string;
}

export interface HotTopic {
  topic: string;
  weight: number;
  count: number;
}

export interface LearnerWarmup {
  predictions: Prediction[];
  hotTopics: HotTopic[];
  /** Whether the learner DB exists and has data. */
  hasData: boolean;
}

interface PredictionRow {
  topic: string;
  confidence: number;
  source: string;
}

interface HotTopicRow {
  topic: string;
  weight: number;
  mention_count: number;
}

export class LearnerClient {
  private db: Database.Database | null = null;

  constructor(private readonly dbPath: string) {}

  /**
   * Read today's predictions and hot topics from the learner DB.
   * Called once on engine startup — fast, synchronous SQLite read.
   * Never throws — returns empty warmup if DB doesn't exist yet.
   */
  warmup(): LearnerWarmup {
    const empty: LearnerWarmup = { predictions: [], hotTopics: [], hasData: false };

    // Learner DB may not exist yet (first run before Python service starts)
    if (!existsSync(this.dbPath)) return empty;

    try {
      if (!this.db) {
        this.db = new Database(this.dbPath, { readonly: true });
      }

      const today = new Date().toISOString().slice(0, 10);

      // Check if learner tables exist
      const tableExists = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='predictions'")
        .get();

      if (!tableExists) return empty;

      const predictions = this.db
        .prepare<[string], PredictionRow>(
          'SELECT topic, confidence, source FROM predictions WHERE predicted_date = ? ORDER BY confidence DESC',
        )
        .all(today)
        .map((r) => ({ topic: r.topic, confidence: r.confidence, source: r.source }));

      const hotTopics = this.db
        .prepare<[], HotTopicRow>(
          'SELECT topic, weight, mention_count FROM interest_map ORDER BY weight DESC LIMIT 15',
        )
        .all()
        .map((r) => ({ topic: r.topic, weight: r.weight, count: r.mention_count }));

      return {
        predictions,
        hotTopics,
        hasData: predictions.length > 0 || hotTopics.length > 0,
      };
    } catch {
      // DB locked, schema mismatch, etc. — never crash on this
      return empty;
    }
  }

  /**
   * Extract just the topic strings for easy use in context building.
   * Returns top predicted + top hot topics merged and deduplicated.
   */
  getContextTopics(warmup: LearnerWarmup, limit = 8): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    // Predictions first (higher confidence = more relevant)
    for (const p of warmup.predictions) {
      if (!seen.has(p.topic)) {
        seen.add(p.topic);
        result.push(p.topic);
      }
    }

    // Fill with hot topics
    for (const h of warmup.hotTopics) {
      if (result.length >= limit) break;
      if (!seen.has(h.topic)) {
        seen.add(h.topic);
        result.push(h.topic);
      }
    }

    return result.slice(0, limit);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
