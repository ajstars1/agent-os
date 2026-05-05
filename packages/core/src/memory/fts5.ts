/**
 * FTS5 Session Search — full-text search across all conversation history.
 *
 * Uses SQLite's built-in FTS5 virtual table for sub-millisecond keyword search,
 * then optionally summarises the top-k results with an LLM for natural-language queries.
 *
 * Schema adds an FTS5 shadow table on top of the existing messages table.
 * Safe to call on an existing DB — schema is idempotent.
 */

import type Database from 'better-sqlite3';
import type { Logger } from '@agent-os-core/shared';

// ─── Schema ───────────────────────────────────────────────────────────────────

export function ensureFts5Schema(db: Database.Database): void {
  // FTS5 virtual table over messages — content table keeps data in `messages`
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(
      content,
      conversation_id UNINDEXED,
      role UNINDEXED,
      created_at UNINDEXED,
      content='messages',
      content_rowid='rowid'
    );

    -- Triggers to keep FTS index in sync
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai
    AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, conversation_id, role, created_at)
      VALUES (new.rowid, new.content, new.conversation_id, new.role, new.created_at);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_ad
    AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, conversation_id, role, created_at)
      VALUES ('delete', old.rowid, old.content, old.conversation_id, old.role, old.created_at);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_au
    AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, conversation_id, role, created_at)
      VALUES ('delete', old.rowid, old.content, old.conversation_id, old.role, old.created_at);
      INSERT INTO messages_fts(rowid, content, conversation_id, role, created_at)
      VALUES (new.rowid, new.content, new.conversation_id, new.role, new.created_at);
    END;
  `);

  // Backfill existing messages into FTS index (idempotent via DELETE then INSERT)
  db.exec(`
    INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
  `);
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface FtsMatch {
  rowid: number;
  conversationId: string;
  role: string;
  content: string;
  createdAt: string;
  rank: number;
}

export interface SessionSearchOptions {
  /** Max results before LLM summarisation (default 20). */
  matchCount?: number;
  /** Only search within a specific conversation. */
  conversationId?: string;
  /** Only return messages from this role. */
  role?: 'user' | 'assistant';
}

export function searchSessions(
  db: Database.Database,
  query: string,
  opts: SessionSearchOptions = {},
): FtsMatch[] {
  const { matchCount = 20, conversationId, role } = opts;

  // Escape FTS5 special chars in query
  const safeQuery = query.replace(/['"*]/g, ' ').trim();
  if (!safeQuery) return [];

  let sql = `
    SELECT
      m.rowid,
      m.conversation_id,
      m.role,
      m.content,
      m.created_at,
      fts.rank
    FROM messages_fts fts
    JOIN messages m ON m.rowid = fts.rowid
    WHERE messages_fts MATCH ?
  `;

  const params: (string | number)[] = [safeQuery];

  if (conversationId) {
    sql += ` AND m.conversation_id = ?`;
    params.push(conversationId);
  }
  if (role) {
    sql += ` AND m.role = ?`;
    params.push(role);
  }

  sql += ` ORDER BY fts.rank LIMIT ?`;
  params.push(matchCount);

  try {
    const rows = db.prepare(sql).all(...params) as Array<{
      rowid: number;
      conversation_id: string;
      role: string;
      content: string;
      created_at: string;
      rank: number;
    }>;

    return rows.map((r) => ({
      rowid: r.rowid,
      conversationId: r.conversation_id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
      rank: r.rank,
    }));
  } catch {
    // FTS5 table may not exist yet — return empty
    return [];
  }
}

// ─── LLM-summarised session search ───────────────────────────────────────────

export interface SummarisedSearchResult {
  query: string;
  matchCount: number;
  summary: string;
  matches: FtsMatch[];
}

export async function searchAndSummarise(
  db: Database.Database,
  query: string,
  opts: SessionSearchOptions & { anthropicKey?: string; geminiKey?: string } = {},
): Promise<SummarisedSearchResult> {
  const matches = searchSessions(db, query, { ...opts, matchCount: opts.matchCount ?? 10 });

  if (matches.length === 0) {
    return { query, matchCount: 0, summary: 'No matching conversations found.', matches: [] };
  }

  // Format matches for summarisation
  const context = matches
    .map((m, i) => {
      const date = m.createdAt ? new Date(m.createdAt).toLocaleDateString() : 'unknown date';
      return `[${i + 1}] (${m.role}, ${date})\n${m.content.slice(0, 300)}`;
    })
    .join('\n\n');

  const prompt = `The user searched their conversation history for: "${query}"

Here are the ${matches.length} most relevant message excerpts:

${context}

Summarise what was found in 2-4 sentences, referencing specific dates and topics.
Focus on answering what the user was looking for.`;

  let summary = `Found ${matches.length} relevant messages. Most recent: ${matches[0]?.content.slice(0, 100)}...`;

  const apiKey = opts.anthropicKey ?? process.env['ANTHROPIC_API_KEY'];
  if (apiKey) {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = msg.content.find((c) => c.type === 'text')?.text ?? '';
      if (text.trim()) summary = text.trim();
    } catch { /* fall back to raw summary */ }
  }

  return { query, matchCount: matches.length, summary, matches };
}
