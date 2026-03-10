import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Message, Conversation, ChannelType } from '@agent-os/shared';
import type { IMemoryStore } from './interface.js';

function expandPath(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

interface ConversationRow {
  id: string;
  channel: string;
  channel_id: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  model: string | null;
  tokens: number | null;
  created_at: string;
}

export class SQLiteMemoryStore implements IMemoryStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const resolved = expandPath(dbPath);
    mkdirSync(dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
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

  getOrCreateConversation(channel: ChannelType, channelId: string): Conversation {
    const existing = this.db
      .prepare<[string, string], ConversationRow>(
        'SELECT * FROM conversations WHERE channel = ? AND channel_id = ?',
      )
      .get(channel, channelId);

    if (existing) {
      return {
        id: existing.id,
        channel: existing.channel as ChannelType,
        channelId: existing.channel_id,
        createdAt: existing.created_at,
        updatedAt: existing.updated_at,
      };
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO conversations (id, channel, channel_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, channel, channelId, now, now);

    return { id, channel, channelId, createdAt: now, updatedAt: now };
  }

  ensureConversation(id: string, channel: ChannelType = 'web'): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT OR IGNORE INTO conversations (id, channel, channel_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, channel, id, now, now);
  }

  addMessage(conversationId: string, msg: Omit<Message, 'id' | 'createdAt'>): Message {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO messages (id, conversation_id, role, content, model, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, conversationId, msg.role, msg.content, msg.model ?? null, msg.tokens ?? null, now);

    // Update conversation updated_at
    this.db
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(now, conversationId);

    return { id, createdAt: now, ...msg };
  }

  getMessages(conversationId: string, limit = 50): Message[] {
    const rows = this.db
      .prepare<[string, number], MessageRow>(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(conversationId, limit)
      .reverse();

    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role as Message['role'],
      content: r.content,
      model: r.model ?? undefined,
      tokens: r.tokens ?? undefined,
      createdAt: r.created_at,
    }));
  }

  listConversations(limit = 50): Conversation[] {
    const rows = this.db
      .prepare<[number], ConversationRow>(
        'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?',
      )
      .all(limit);

    return rows.map((r) => ({
      id: r.id,
      channel: r.channel as ChannelType,
      channelId: r.channel_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  getConversationMessages(conversationId: string, limit = 100): Message[] {
    const rows = this.db
      .prepare<[string, number], MessageRow>(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?',
      )
      .all(conversationId, limit);

    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role as Message['role'],
      content: r.content,
      model: r.model ?? undefined,
      tokens: r.tokens ?? undefined,
      createdAt: r.created_at,
    }));
  }

  clearConversation(conversationId: string): void {
    this.db
      .prepare('DELETE FROM messages WHERE conversation_id = ?')
      .run(conversationId);
  }

  close(): void {
    this.db.close();
  }
}
