import { describe, expect, test } from 'bun:test'
import { blockReason, decideBlock, loginsFromCookies, needsOf, SKIP_RETRY_MS, type CookieRow } from './preflight'

const NOW = Date.UTC(2026, 10, 3)
// Chrome time: microseconds since 1601-01-01
const chromeUs = (ms: number): number => (ms + 11_644_473_600_000) * 1000
const future = chromeUs(NOW + 86_400_000)
const past = chromeUs(NOW - 86_400_000)
const row = (host_key: string, name: string, expires_utc = future): CookieRow => ({ host_key, name, expires_utc, has_expires: 1 })

describe('needsOf', () => {
  test('LinkedIn and Gmail from the task text', () => {
    expect(needsOf({ title: 'Reply check: LinkedIn, Gmail, Reddit', prompt: null })).toEqual({ chrome: true, gmail: true, linkedin: true })
  })
  test('a send uses the approval channel', () => {
    expect(needsOf({ title: 'SEND APPROVED #38', prompt: null }, 'linkedin-connect').linkedin).toBe(true)
    expect(needsOf({ title: 'SEND APPROVED #40', prompt: null }, 'email').gmail).toBe(true)
  })
  test('other tasks need only Chrome', () => {
    expect(needsOf({ title: 'Indie Hackers: draft 2 comments', prompt: 'Draft comments' })).toEqual({ chrome: true, gmail: false, linkedin: false })
  })
})

describe('loginsFromCookies', () => {
  test('live session cookies mean logged in', () => {
    const rows = [row('.google.com', 'SID'), row('mail.google.com', 'OSID'), row('.www.linkedin.com', 'li_at')]
    expect(loginsFromCookies(rows, NOW)).toEqual({ gmail: true, linkedin: true })
  })
  test('missing or expired cookies mean logged out', () => {
    expect(loginsFromCookies([row('.google.com', 'SID'), row('.www.linkedin.com', 'li_at', past)], NOW)).toEqual({
      gmail: false,
      linkedin: false,
    })
  })
})

describe('blockReason', () => {
  const all = { chrome: true, gmail: true, linkedin: true }
  test('healthy needs pass', () => {
    expect(blockReason(all, all)).toBeNull()
    expect(blockReason({ chrome: true, gmail: false, linkedin: false }, { chrome: true, gmail: false, linkedin: false })).toBeNull()
  })
  test('lists what is down in a stable order', () => {
    expect(blockReason(all, { chrome: false, gmail: true, linkedin: false })).toBe(
      'preflight: Chrome extension not connected; LinkedIn not logged in',
    )
  })
})

describe('decideBlock (preflight skip logic)', () => {
  const reason = 'preflight: LinkedIn not logged in'
  test('first block retries later', () => {
    expect(decideBlock(null, reason)).toEqual({ kind: 'retry', retryMs: SKIP_RETRY_MS })
    expect(decideBlock({ status: 'ok', summary: 'done' }, reason).kind).toBe('retry')
  })
  test('a different previous block is not identical', () => {
    expect(decideBlock({ status: 'skipped', summary: 'preflight: Gmail not logged in' }, reason).kind).toBe('retry')
  })
  test('the second identical block in a row pauses', () => {
    expect(decideBlock({ status: 'skipped', summary: reason }, reason)).toEqual({ kind: 'pause' })
  })
})
