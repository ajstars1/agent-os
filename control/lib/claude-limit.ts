// Claude usage limits: recognise the "limit reached, resets 7pm" messages Claude Code prints, and keep one shared
// "blocked until" state for this machine (same account for the runner and every session), so nothing starts a
// Claude run before the reset and stalled sessions can be resumed after it.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STATE = join(import.meta.dirname, '..', 'runner', '.claude-limit.json')

/** With no reset time in the message, try again after an hour. */
export const UNKNOWN_RETRY_MS = 60 * 60 * 1000

export interface LimitState {
  /** ISO time the limit resets, or null when the message gave none. */
  until: string | null
  since: string
  /** Who saw it: 'runner' | 'agent' | 'session:<name>'. */
  source: string
}

const LIMIT_RE = /usage limit|limit reached|hit your (?:[\w-]+ )?limit|limit will reset|out of extra usage/i

/** A reset time this far in the past is the one that just passed (a late or repeated message), not tomorrow's. */
const JUST_PASSED_MS = 5 * 60 * 60 * 1000
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const RESET_RE = new RegExp(
  String.raw`resets?\s+(?:at\s+|on\s+)?(?:(${MONTHS.join('|')})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)`,
  'i',
)

// Claude Code prints reset times in the user's zone: IST (no DST), whatever TZ the process runs with.
const TZ_OFFSET_MS = Number(process.env.AOS_TZ_OFFSET_MIN ?? 330) * 60_000

/** null: not a limit message. until null: a limit message without a readable reset time. */
export const parseLimit = (text: string, now: Date = new Date()): { until: Date | null } | null => {
  if (!LIMIT_RE.test(text)) return null
  const epoch = /limit reached\|(\d{10})\b/i.exec(text)
  if (epoch?.[1]) return { until: new Date(Number(epoch[1]) * 1000) }
  const m = RESET_RE.exec(text)
  if (!m) return { until: null }
  const [, mon, day, h, min, ampm] = m
  const hour = (Number(h) % 12) + (ampm!.toLowerCase() === 'pm' ? 12 : 0)
  const local = new Date(now.getTime() + TZ_OFFSET_MS) // wall clock in the UTC fields
  const at = (y: number, mo: number, d: number): Date => new Date(Date.UTC(y, mo, d, hour, Number(min ?? 0)) - TZ_OFFSET_MS)
  if (mon) {
    const mo = MONTHS.indexOf(mon.toLowerCase().slice(0, 3))
    const thisYear = at(local.getUTCFullYear(), mo, Number(day))
    // "Jan 2" seen in late Dec is next year
    return { until: thisYear.getTime() < now.getTime() - 86_400_000 ? at(local.getUTCFullYear() + 1, mo, Number(day)) : thisYear }
  }
  const today = at(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
  // "resets 7am" seen at 10pm means tomorrow; "resets 2pm" seen at 2:01pm is the reset that just passed
  // (31 Oct / 1 Nov: read as tomorrow 2pm, it blocked the runner for a day)
  const behind = now.getTime() - today.getTime()
  return { until: behind > JUST_PASSED_MS ? new Date(today.getTime() + 86_400_000) : today }
}

export const readLimit = (): LimitState | null => {
  try {
    return existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as LimitState) : null
  } catch {
    return null
  }
}

export const writeLimit = (s: LimitState | null): void => {
  if (s) writeFileSync(STATE, JSON.stringify(s))
  else if (existsSync(STATE)) unlinkSync(STATE)
}

/** When Claude can be used again, or null if it can be used now. */
export const blockedUntil = (s: LimitState | null, now: Date = new Date()): Date | null => {
  if (!s) return null
  const until = s.until ? new Date(s.until) : new Date(new Date(s.since).getTime() + UNKNOWN_RETRY_MS)
  return until.getTime() > now.getTime() ? until : null
}

export const fmtTime = (d: Date): string =>
  d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true, weekday: 'short' })
