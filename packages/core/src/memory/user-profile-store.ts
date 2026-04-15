/**
 * UserProfileStore — who the user is, what they're building, how they work.
 *
 * This is the "relationship memory" — what makes AgentOS feel like a companion
 * rather than a stateless tool. It persists across all sessions and is updated
 * silently after each conversation exchange.
 *
 * Design: single-row JSON blob per user (keyed by user_id, default = "default").
 * Updates are deep-merged, never replaced wholesale. This means inferred facts
 * accumulate over time rather than flickering.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

function expandPath(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

export type CommunicationStyle = 'concise' | 'detailed' | 'technical' | 'casual' | 'unknown';

export interface UserProject {
  name: string;
  description: string;
  stack: string[];
  status: 'active' | 'paused' | 'shipped' | 'ideating';
  lastMentioned: number; // unix ms
}

export interface UserProfile {
  userId: string;

  // ── Identity ──────────────────────────────────────────────────────────────
  name?: string;
  role?: string;            // "full-stack founder", "solo dev", etc.
  location?: string;

  // ── Technical context ─────────────────────────────────────────────────────
  /** Primary tech stack across all projects. */
  primaryStack: string[];
  /** Projects the user has mentioned — kept sorted by lastMentioned. */
  currentProjects: UserProject[];

  // ── Preferences ───────────────────────────────────────────────────────────
  communicationStyle: CommunicationStyle;
  /** Languages/frameworks the user prefers for new code. */
  codingPreferences: string[];

  // ── Relationship ──────────────────────────────────────────────────────────
  sessionCount: number;
  firstSeen: string;   // ISO-8601
  lastSeen: string;    // ISO-8601

  /**
   * Freeform key-value facts that don't fit other fields.
   * e.g. { "team": "Ayush + Shiven", "agency": "Arcane Design Studios" }
   */
  facts: Record<string, string>;

  updatedAt: string; // ISO-8601
}

const DEFAULT_PROFILE: Omit<UserProfile, 'userId' | 'firstSeen' | 'lastSeen' | 'updatedAt'> = {
  primaryStack: [],
  currentProjects: [],
  communicationStyle: 'unknown',
  codingPreferences: [],
  sessionCount: 0,
  facts: {},
};

interface ProfileRow {
  user_id: string;
  data: string;
}

export type PartialUserProfile = Partial<Omit<UserProfile, 'userId'>>;

export class UserProfileStore {
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
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id    TEXT PRIMARY KEY,
        data       TEXT NOT NULL
      );
    `);
  }

  /** Get profile, creating a default one if this is the first session. */
  get(userId = 'default'): UserProfile {
    const row = this.db
      .prepare<[string], ProfileRow>('SELECT * FROM user_profiles WHERE user_id = ?')
      .get(userId);

    if (!row) {
      const now = new Date().toISOString();
      const fresh: UserProfile = {
        ...DEFAULT_PROFILE,
        userId,
        firstSeen: now,
        lastSeen: now,
        updatedAt: now,
      };
      this.db
        .prepare('INSERT INTO user_profiles (user_id, data) VALUES (?, ?)')
        .run(userId, JSON.stringify(fresh));
      return fresh;
    }

    return JSON.parse(row.data) as UserProfile;
  }

  /**
   * Deep-merge a partial update into the profile.
   * Arrays are UNIONED (no duplicates). Strings replace. Records are merged.
   */
  merge(update: PartialUserProfile, userId = 'default'): UserProfile {
    const current = this.get(userId);
    const now = new Date().toISOString();

    const merged: UserProfile = {
      ...current,
      ...update,
      // String fields — only update if new value is non-empty
      name: update.name?.trim() || current.name,
      role: update.role?.trim() || current.role,
      location: update.location?.trim() || current.location,
      // Array fields — union
      primaryStack: union(current.primaryStack, update.primaryStack ?? []),
      codingPreferences: union(current.codingPreferences, update.codingPreferences ?? []),
      // Projects — merge by name
      currentProjects: mergeProjects(current.currentProjects, update.currentProjects ?? []),
      // Facts — shallow merge
      facts: { ...current.facts, ...(update.facts ?? {}) },
      // Always update
      communicationStyle: update.communicationStyle ?? current.communicationStyle,
      lastSeen: now,
      updatedAt: now,
    };

    this.db
      .prepare('INSERT OR REPLACE INTO user_profiles (user_id, data) VALUES (?, ?)')
      .run(userId, JSON.stringify(merged));

    return merged;
  }

  /** Increment session count — call once per CLI/Discord session start. */
  recordSession(userId = 'default'): void {
    const profile = this.get(userId);
    this.merge({ sessionCount: profile.sessionCount + 1 }, userId);
  }

  close(): void {
    this.db.close();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function union(a: string[], b: string[]): string[] {
  const set = new Set([...a, ...b.filter((s) => s.trim().length > 0)]);
  return Array.from(set);
}

function mergeProjects(existing: UserProject[], incoming: UserProject[]): UserProject[] {
  const map = new Map<string, UserProject>(existing.map((p) => [p.name.toLowerCase(), p]));
  for (const p of incoming) {
    const key = p.name.toLowerCase();
    const prev = map.get(key);
    if (prev) {
      map.set(key, {
        ...prev,
        ...p,
        stack: union(prev.stack, p.stack),
        lastMentioned: Math.max(prev.lastMentioned, p.lastMentioned),
      });
    } else {
      map.set(key, p);
    }
  }
  // Sort by most recently mentioned
  return Array.from(map.values()).sort((a, b) => b.lastMentioned - a.lastMentioned);
}
