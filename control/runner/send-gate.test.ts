// bun test runner/send-gate.test.ts  (lives in runner/ because bun:test types are outside the Next type-check)
import { describe, expect, it } from 'bun:test'
import { approvalIdFromTitle, checkSend, sendableText } from '../lib/send-gate'
import { checkBudget } from '../lib/run-budget'

const GMAIL = `SEND AS A REPLY IN THE EXISTING GMAIL THREAD (this header is not part of the email)
From: a@b.com
Thread: NOT VERIFIED. https://x.test/1 https://x.test/2 https://x.test/3

EMAIL BODY:
Hi Preetam,

Five questions for your ML interviews.

Ayush`

describe('sendableText', () => {
  it('reads only what is sent', () => {
    expect(sendableText(GMAIL)).toBe('Hi Preetam,\n\nFive questions for your ML interviews.\n\nAyush')
    expect(sendableText('NEW ACCEPT (29 Oct). Send today.\n\nThanks for connecting, Riya.')).toBe(
      'Thanks for connecting, Riya.',
    )
    expect(sendableText('Plain message')).toBe('Plain message')
  })
})

describe('checkSend', () => {
  it('passes a clean approved draft (header links do not count)', () => {
    expect(checkSend('gmail', 'pat@example.com', GMAIL)).toEqual({ ok: true, reasons: [] })
  })

  it('blocks placeholders, em dashes, link spam and bad recipients', () => {
    const r = checkSend('gmail', 'ExampleCo', 'Hi {{first_name}} — see https://a.test https://b.test https://c.test')
    expect(r.ok).toBe(false)
    expect(r.reasons.join(' | ')).toContain('{{first_name}}')
    expect(r.reasons.join(' | ')).toContain('em dash')
    expect(r.reasons.join(' | ')).toContain('3 links')
    expect(r.reasons.join(' | ')).toContain('no email address')
    expect(checkSend('linkedin-dm', 'Riya', 'Hi [First Name]').reasons.length).toBe(2)
    expect(checkSend('linkedin-dm', 'Riya https://www.linkedin.com/in/example-person/', 'x'.repeat(1600)).reasons[0]).toContain('over the 1500 cap')
  })

  it('reads the approval id from a send task title', () => {
    expect(approvalIdFromTitle('SEND APPROVED #24 (gmail to hello@example.org)')).toBe(24)
    expect(approvalIdFromTitle('Reply check (evening)')).toBeNull()
  })
})

describe('checkBudget', () => {
  const now = new Date('2026-11-01T12:00:00Z')
  const run = (minsAgo: number, usd: number) => ({
    started_at: new Date(now.getTime() - minsAgo * 60_000).toISOString(),
    cost_usd: usd,
  })

  it('allows runs under both limits and ignores runs older than 5 h', () => {
    const v = checkBudget([run(10, 2), run(400, 50)], { maxRuns: 10, maxUsd: 15 }, now)
    expect(v).toEqual({ ok: true, runs: 1, usd: 2, freeAt: null })
  })

  it('pauses at the run or cost cap and says when the oldest run leaves the window', () => {
    const v = checkBudget([run(30, 8), run(200, 8)], { maxRuns: 10, maxUsd: 15 }, now)
    expect(v.ok).toBe(false)
    expect(v.freeAt?.toISOString()).toBe(new Date(now.getTime() + 100 * 60_000).toISOString())
    expect(checkBudget([run(1, 0.5), run(2, 0.5)], { maxRuns: 2, maxUsd: 15 }, now).ok).toBe(false)
  })

  it('does not count $0 runs that died at the limit', () => {
    expect(checkBudget([run(1, 0), run(2, 0), run(3, 0)], { maxRuns: 2, maxUsd: 15 }, now).ok).toBe(true)
  })
})
