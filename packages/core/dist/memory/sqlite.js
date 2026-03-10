import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
function expandPath(p) {
    return p.startsWith('~') ? p.replace('~', homedir()) : p;
}
export class SQLiteMemoryStore {
    db;
    constructor(dbPath) {
        const resolved = expandPath(dbPath);
        mkdirSync(dirname(resolved), { recursive: true });
        this.db = new Database(resolved);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.migrate();
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id         TEXT PRIMARY KEY,
        channel    TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conv ON conversations(channel, channel_id);

      CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        model           TEXT,
        tokens          INTEGER,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_msg ON messages(conversation_id, created_at);
    `);
    }
    getOrCreateConversation(channel, channelId) {
        const existing = this.db
            .prepare('SELECT * FROM conversations WHERE channel = ? AND channel_id = ?')
            .get(channel, channelId);
        if (existing) {
            return {
                id: existing.id,
                channel: existing.channel,
                channelId: existing.channel_id,
                createdAt: existing.created_at,
                updatedAt: existing.updated_at,
            };
        }
        const now = new Date().toISOString();
        const id = randomUUID();
        this.db
            .prepare('INSERT INTO conversations (id, channel, channel_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run(id, channel, channelId, now, now);
        return { id, channel, channelId, createdAt: now, updatedAt: now };
    }
    addMessage(conversationId, msg) {
        const now = new Date().toISOString();
        const id = randomUUID();
        this.db
            .prepare('INSERT INTO messages (id, conversation_id, role, content, model, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(id, conversationId, msg.role, msg.content, msg.model ?? null, msg.tokens ?? null, now);
        // Update conversation updated_at
        this.db
            .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
            .run(now, conversationId);
        return { id, createdAt: now, ...msg };
    }
    getMessages(conversationId, limit = 50) {
        const rows = this.db
            .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?')
            .all(conversationId, limit)
            .reverse();
        return rows.map((r) => ({
            id: r.id,
            conversationId: r.conversation_id,
            role: r.role,
            content: r.content,
            model: r.model ?? undefined,
            tokens: r.tokens ?? undefined,
            createdAt: r.created_at,
        }));
    }
    clearConversation(conversationId) {
        this.db
            .prepare('DELETE FROM messages WHERE conversation_id = ?')
            .run(conversationId);
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=sqlite.js.map