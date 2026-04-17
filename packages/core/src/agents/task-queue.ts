/**
 * TaskQueue — SQLite-backed task store for multi-agent sessions.
 *
 * Each task belongs to a session (conversationId). Workers claim tasks by
 * setting status → 'running'. Results land in output/error. The Orchestrator
 * waits for all tasks in a session to reach terminal state before synthesizing.
 *
 * Isolation guarantee: every task has its own context window — workers never
 * read each other's intermediate state; only final outputs feed the Reducer.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type TaskType = 'research' | 'code' | 'plan' | 'general';
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Task {
  id: string;
  sessionId: string;
  type: TaskType;
  /** Plain-text instruction for the worker — no raw user message; pre-processed by Orchestrator. */
  instruction: string;
  status: TaskStatus;
  /** Final worker output (plain text, may be markdown). */
  output: string | null;
  /** Error message on failure. */
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface TaskRow {
  id: string;
  session_id: string;
  type: string;
  instruction: string;
  status: string;
  output: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type as TaskType,
    instruction: row.instruction,
    status: row.status as TaskStatus,
    output: row.output,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskQueue {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath === ':memory:' ? ':memory:' : dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        type         TEXT NOT NULL,
        instruction  TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        output       TEXT,
        error        TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_session ON agent_tasks (session_id, status);
    `);
  }

  create(sessionId: string, type: TaskType, instruction: string): Task {
    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      sessionId,
      type,
      instruction,
      status: 'pending',
      output: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO agent_tasks (id, session_id, type, instruction, status, output, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.sessionId, task.type, task.instruction, task.status, task.output, task.error, task.createdAt, task.updatedAt);
    return task;
  }

  markRunning(taskId: string): void {
    this.db.prepare('UPDATE agent_tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run('running', Date.now(), taskId);
  }

  complete(taskId: string, output: string): void {
    this.db.prepare('UPDATE agent_tasks SET status = ?, output = ?, updated_at = ? WHERE id = ?')
      .run('done', output, Date.now(), taskId);
  }

  fail(taskId: string, error: string): void {
    this.db.prepare('UPDATE agent_tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .run('failed', error, Date.now(), taskId);
  }

  getBySession(sessionId: string): Task[] {
    const rows = this.db
      .prepare<[string], TaskRow>('SELECT * FROM agent_tasks WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId);
    return rows.map(rowToTask);
  }

  /** Clean up old sessions to prevent unbounded growth (keep last 24 h). */
  pruneOld(maxAgeMs = 86_400_000): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db
      .prepare('DELETE FROM agent_tasks WHERE created_at < ? AND status IN (?, ?)')
      .run(cutoff, 'done', 'failed');
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
