// Health preflight before each runner spawn (aos v2 Phase 0): if the browser or a needed login is down, the run
// is skipped before Claude starts, so it costs no tokens. Two identical blocks in a row pause the task.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export interface Needs {
  chrome: boolean
  gmail: boolean
  linkedin: boolean
}

export interface Health {
  chrome: boolean
  gmail: boolean
  linkedin: boolean
}

// What a task needs, from its text and (for a send) the approval's channel. Every runner session gets --chrome.
export const needsOf = (task: { title: string; prompt: string | null }, channel?: string | null): Needs => {
  const text = `${task.title}\n${task.prompt ?? ''}\n${channel ?? ''}`.toLowerCase()
  const ch = (channel ?? '').toLowerCase()
  return {
    chrome: true,
    gmail: /\bgmail\b|mail\.google\.com/.test(text) || ch === 'email' || ch.startsWith('gmail'),
    linkedin: /linkedin/.test(text),
  }
}

// Stable wording: two blocks are "identical" when these strings match.
export const blockReason = (needs: Needs, health: Health): string | null => {
  const missing: string[] = []
  if (needs.chrome && !health.chrome) missing.push('Chrome extension not connected')
  if (needs.gmail && !health.gmail) missing.push('Gmail not logged in')
  if (needs.linkedin && !health.linkedin) missing.push('LinkedIn not logged in')
  return missing.length ? `preflight: ${missing.join('; ')}` : null
}

export const SKIP_RETRY_MS = 30 * 60 * 1000

export type BlockAction = { kind: 'retry'; retryMs: number } | { kind: 'pause' }

// prev is the task's most recent run row. A second identical preflight block in a row pauses the task.
export const decideBlock = (prev: { status: string; summary: string | null } | null, reason: string): BlockAction =>
  prev?.status === 'skipped' && prev.summary === reason ? { kind: 'pause' } : { kind: 'retry', retryMs: SKIP_RETRY_MS }

// Chrome stores cookie expiry as microseconds since 1601-01-01 UTC.
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000
export const chromeTimeToMs = (us: number): number => us / 1000 - CHROME_EPOCH_OFFSET_MS

export interface CookieRow {
  host_key: string
  name: string
  expires_utc: number
  has_expires: number
}

const alive = (rows: CookieRow[], host: (h: string) => boolean, name: string, nowMs: number): boolean =>
  rows.some((r) => host(r.host_key) && r.name === name && (!r.has_expires || chromeTimeToMs(r.expires_utc) > nowMs))

// Logged in = the session cookies exist and are not expired (logging out deletes them). Values are never read.
export const loginsFromCookies = (rows: CookieRow[], nowMs: number): { gmail: boolean; linkedin: boolean } => ({
  gmail:
    alive(rows, (h) => h === '.google.com', 'SID', nowMs) &&
    alive(rows, (h) => h === 'mail.google.com', 'OSID', nowMs),
  linkedin: alive(rows, (h) => h.endsWith('linkedin.com'), 'li_at', nowMs),
})

export const cookiesPath = (): string =>
  process.env.AOS_CHROME_COOKIES ?? join(homedir(), '.config', 'google-chrome', 'Default', 'Cookies')

// Reads cookie names and expiry from a copy of Chrome's cookie DB (Chrome keeps the original locked).
export const readLogins = async (nowMs: number, path = cookiesPath()): Promise<{ gmail: boolean; linkedin: boolean }> => {
  if (!existsSync(path)) return { gmail: false, linkedin: false }
  const dir = mkdtempSync(join(tmpdir(), 'aos-cookies-'))
  try {
    const copy = join(dir, 'Cookies')
    copyFileSync(path, copy)
    const { Database } = await import('bun:sqlite')
    const db = new Database(copy, { readonly: true })
    try {
      const rows = db
        .query(
          `select host_key, name, expires_utc, has_expires from cookies
           where (host_key like '%linkedin.com' and name = 'li_at')
              or (host_key in ('.google.com', 'mail.google.com') and name in ('SID', 'OSID'))`,
        )
        .all() as CookieRow[]
      return loginsFromCookies(rows, nowMs)
    } finally {
      db.close()
    }
  } catch {
    return { gmail: false, linkedin: false }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const ENSURE_CHROME = join(homedir(), 'Developer', 'Ayush', 'agent-os', 'control', 'hooks', 'ensure-chrome.sh')

// Starts Chrome if needed (hooks/ensure-chrome.sh waits up to 25 s), then checks the extension's native host.
export const chromeReachable = (): boolean => {
  spawnSync('bash', [ENSURE_CHROME], { stdio: 'ignore', timeout: 40_000 })
  // anchored so a shell whose command line merely mentions the host does not count
  return spawnSync('pgrep', ['-f', '^[^ ]*claude --chrome-native-host'], { stdio: 'ignore' }).status === 0
}

export const preflight = async (needs: Needs, nowMs: number): Promise<string | null> => {
  const chrome = needs.chrome ? chromeReachable() : true
  const logins = needs.gmail || needs.linkedin ? await readLogins(nowMs) : { gmail: true, linkedin: true }
  return blockReason(needs, { chrome, ...logins })
}
