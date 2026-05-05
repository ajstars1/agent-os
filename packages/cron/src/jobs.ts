import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';

// ─── Types ────────────────────────────────────────────────────────────────────

export type JobStatus = 'pending' | 'running' | 'success' | 'error' | 'timeout';
export type DeliveryTarget = 'local' | 'cli' | 'discord' | 'telegram' | 'slack' | 'email';

export interface CronJob {
  id: string;
  name: string;
  prompt: string;
  /** cron expression, "every Xm", "Xm", or ISO timestamp */
  schedule: string;
  nextRunAt: number; // unix ms
  lastRunAt: number | null;
  lastStatus: JobStatus | null;
  deliver: DeliveryTarget;
  enabled: boolean;
  model?: string;
  /** How many times to run (null = unlimited) */
  repeatTimes: number | null;
  completedRuns: number;
  createdAt: number;
}

// ─── Schedule parsing ─────────────────────────────────────────────────────────

const CRON_REGEX = /^(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)$/;

function parseDuration(s: string): number | null {
  const m = s.match(/^(\d+)(s|m|h|d)$/i);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 0;
  return n * mult;
}

/** Returns the next unix ms timestamp given a schedule string and current time. */
export function nextRunMs(schedule: string, fromMs = Date.now()): number {
  const s = schedule.trim();

  // "every Xm" / "every Xh" etc
  const every = s.match(/^every\s+(.+)$/i);
  if (every) {
    const dur = parseDuration(every[1]!.trim());
    if (dur) return fromMs + dur;
  }

  // bare duration: "30m", "2h", "1d"
  const dur = parseDuration(s);
  if (dur) return fromMs + dur;

  // ISO timestamp: "2026-05-10T14:00"
  const ts = Date.parse(s);
  if (!isNaN(ts)) return ts;

  // cron expression (basic — minute/hour/day/month/weekday)
  if (CRON_REGEX.test(s)) {
    return nextCronMs(s, fromMs);
  }

  // fallback: 1 hour
  return fromMs + 3_600_000;
}

/** Minimal cron next-fire calculator. Supports * and fixed values, not ranges/steps. */
function nextCronMs(expr: string, fromMs: number): number {
  const [minE, hrE, , , ] = expr.split(/\s+/);
  const from = new Date(fromMs);
  // advance by 1 minute to find NEXT trigger
  const candidate = new Date(from.getTime() + 60_000);
  candidate.setSeconds(0, 0);

  for (let i = 0; i < 60 * 24 * 7; i++) {
    const m = candidate.getMinutes();
    const h = candidate.getHours();
    const matchMin = minE === '*' || String(m) === minE;
    const matchHr = hrE === '*' || String(h) === hrE;
    if (matchMin && matchHr) return candidate.getTime();
    candidate.setTime(candidate.getTime() + 60_000);
  }

  return fromMs + 3_600_000;
}

// ─── SQLite job store ─────────────────────────────────────────────────────────

function dbPath(): string {
  const dir = join(homedir(), '.agent-os', 'cron');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'jobs.db');
}

let _db: ReturnType<typeof Database> | null = null;

function getDb(): ReturnType<typeof Database> {
  if (_db) return _db;
  _db = new Database(dbPath());
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      prompt      TEXT NOT NULL,
      schedule    TEXT NOT NULL,
      next_run_at INTEGER NOT NULL,
      last_run_at INTEGER,
      last_status TEXT,
      deliver     TEXT NOT NULL DEFAULT 'local',
      enabled     INTEGER NOT NULL DEFAULT 1,
      model       TEXT,
      repeat_times INTEGER,
      completed_runs INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    )
  `);
  return _db;
}

function rowToJob(row: Record<string, unknown>): CronJob {
  return {
    id: String(row['id']),
    name: String(row['name']),
    prompt: String(row['prompt']),
    schedule: String(row['schedule']),
    nextRunAt: Number(row['next_run_at']),
    lastRunAt: row['last_run_at'] != null ? Number(row['last_run_at']) : null,
    lastStatus: (row['last_status'] as JobStatus | null) ?? null,
    deliver: (row['deliver'] as DeliveryTarget) ?? 'local',
    enabled: Boolean(row['enabled']),
    model: row['model'] ? String(row['model']) : undefined,
    repeatTimes: row['repeat_times'] != null ? Number(row['repeat_times']) : null,
    completedRuns: Number(row['completed_runs']),
    createdAt: Number(row['created_at']),
  };
}

// ─── Public CRUD ──────────────────────────────────────────────────────────────

export const CreateJobSchema = z.object({
  name: z.string().min(1).max(64),
  prompt: z.string().min(1),
  schedule: z.string().min(1),
  deliver: z.enum(['local', 'cli', 'discord', 'telegram', 'slack', 'email']).default('local'),
  model: z.string().optional(),
  repeatTimes: z.number().int().min(1).optional(),
});

export function createJob(input: z.infer<typeof CreateJobSchema>): CronJob {
  const db = getDb();
  const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const nextRun = nextRunMs(input.schedule, now);

  db.prepare(`
    INSERT INTO cron_jobs (id, name, prompt, schedule, next_run_at, deliver, model, repeat_times, completed_runs, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, input.name, input.prompt, input.schedule, nextRun, input.deliver, input.model ?? null, input.repeatTimes ?? null, now);

  return getJob(id)!;
}

export function getJob(id: string): CronJob | null {
  const row = getDb().prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToJob(row) : null;
}

export function listJobs(): CronJob[] {
  const rows = getDb().prepare('SELECT * FROM cron_jobs ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToJob);
}

export function getDueJobs(nowMs = Date.now()): CronJob[] {
  const rows = getDb()
    .prepare('SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at <= ?')
    .all(nowMs) as Record<string, unknown>[];
  return rows.map(rowToJob);
}

export function updateJobAfterRun(id: string, status: JobStatus, schedule: string): void {
  const db = getDb();
  const now = Date.now();
  const next = nextRunMs(schedule, now);
  db.prepare(`
    UPDATE cron_jobs
    SET last_run_at = ?, last_status = ?, next_run_at = ?, completed_runs = completed_runs + 1
    WHERE id = ?
  `).run(now, status, next, id);
}

export function enableJob(id: string, enabled: boolean): void {
  getDb().prepare('UPDATE cron_jobs SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

export function deleteJob(id: string): void {
  getDb().prepare('DELETE FROM cron_jobs WHERE id = ?').run(id);
}
