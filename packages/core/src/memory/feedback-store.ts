import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { MessageRole } from '@agent-os-core/shared';

export interface FeedbackHistoryTurn {
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface FeedbackEntry {
  id: number;
  timestamp: number;
  context: string;
  text: string;
  applied: number; // 0 = pending, 1 = applied in sleep cycle
  history: FeedbackHistoryTurn[];
}

interface FeedbackRow {
  id: number;
  timestamp: number;
  context: string;
  text: string;
  applied: number;
  history: string | null;
}

const HISTORY_TURN_CHAR_LIMIT = 500;

export class FeedbackStore {
  private readonly db: Database.Database;

  constructor(dbPath?: string) {
    const raw = dbPath ?? join(homedir(), '.agent-os', 'feedback.db');
    const path = raw.startsWith('~') ? raw.replace('~', homedir()) : raw;
    mkdirSync(join(homedir(), '.agent-os'), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        context   TEXT    NOT NULL DEFAULT '',
        text      TEXT    NOT NULL,
        applied   INTEGER NOT NULL DEFAULT 0,
        history   TEXT
      )
    `);
    // Migrate older DBs that pre-date the history column
    const cols = this.db
      .prepare("PRAGMA table_info(feedback)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'history')) {
      this.db.exec('ALTER TABLE feedback ADD COLUMN history TEXT');
    }
  }

  add(text: string, context = '', history: FeedbackHistoryTurn[] = []): void {
    const historyJson = history.length > 0 ? JSON.stringify(history) : null;
    this.db
      .prepare(
        'INSERT INTO feedback (timestamp, context, text, history) VALUES (?, ?, ?, ?)',
      )
      .run(Date.now(), context, text, historyJson);
  }

  /** Get all unapplied feedback entries (for sleep cycle consumption). */
  getPending(limit = 20): FeedbackEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM feedback WHERE applied = 0 ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as FeedbackRow[];
    return rows.map(rowToEntry);
  }

  /** Get all feedback entries (for display). */
  getAll(limit = 50): FeedbackEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM feedback ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as FeedbackRow[];
    return rows.map(rowToEntry);
  }

  /** Mark entries as applied after sleep-cycle consumption. */
  markApplied(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare(`UPDATE feedback SET applied = 1 WHERE id IN (${placeholders})`)
      .run(...ids);
  }

  /** Build a summary block suitable for injecting into sleep-cycle prompts. */
  buildFeedbackContext(): string {
    const entries = this.getPending(20);
    if (entries.length === 0) return '';

    const blocks = entries.map((e) => {
      const date = new Date(e.timestamp).toLocaleDateString();
      const header = `- [${date}] ${e.text}`;
      if (e.history.length === 0) {
        const ctx = e.context ? `\n    context: ${e.context.slice(0, 120)}` : '';
        return `${header}${ctx}`;
      }
      const turns = e.history
        .map((t) => {
          const body = t.content.length > HISTORY_TURN_CHAR_LIMIT
            ? `${t.content.slice(0, HISTORY_TURN_CHAR_LIMIT)}… [${t.content.length} chars]`
            : t.content;
          return `    ${t.role}: ${body.replace(/\n/g, ' ')}`;
        })
        .join('\n');
      return `${header}\n  Recent exchange being critiqued:\n${turns}`;
    });

    return `User Feedback (incorporate into future behavior):\n${blocks.join('\n\n')}`;
  }
}

function rowToEntry(row: FeedbackRow): FeedbackEntry {
  let history: FeedbackHistoryTurn[] = [];
  if (row.history) {
    try {
      const parsed: unknown = JSON.parse(row.history);
      if (Array.isArray(parsed)) {
        history = parsed.filter(isHistoryTurn);
      }
    } catch {
      // Malformed row — drop history, keep the rest of the entry usable
    }
  }
  return {
    id: row.id,
    timestamp: row.timestamp,
    context: row.context,
    text: row.text,
    applied: row.applied,
    history,
  };
}

function isHistoryTurn(v: unknown): v is FeedbackHistoryTurn {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['role'] === 'string' &&
    typeof o['content'] === 'string' &&
    typeof o['createdAt'] === 'string'
  );
}
