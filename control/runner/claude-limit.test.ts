// bun test runner/claude-limit.test.ts  (lives in runner/ because bun:test types are outside the Next type-check)
import { describe, expect, it } from 'bun:test'
import { blockedUntil, parseLimit } from '../lib/claude-limit'

const at = (iso: string): Date => new Date(iso)
const NOW = at('2026-10-31T14:05:00+05:30')

describe('parseLimit', () => {
  it('ignores ordinary text', () => {
    expect(parseLimit('Sent 3 emails, rate limited by Gmail once', NOW)).toBeNull()
    expect(parseLimit('resets 7pm', NOW)).toBeNull()
  })

  it('reads the formats Claude Code prints', () => {
    const cases: [string, string][] = [
      ['5-hour limit reached ∙ resets 7pm', '2026-10-31T19:00:00+05:30'],
      ["You've hit your limit · resets 7:30pm (Asia/Calcutta)", '2026-10-31T19:30:00+05:30'],
      ['Claude usage limit reached. Your limit will reset at 3pm (Asia/Kolkata).', '2026-10-31T15:00:00+05:30'],
      ['Session limit reached ∙ resets 12am', '2026-11-01T00:00:00+05:30'],
      ['Weekly limit reached ∙ resets Nov 3, 9am', '2026-11-03T09:00:00+05:30'],
      ['Opus weekly limit reached ∙ resets Nov 3 at 9am', '2026-11-03T09:00:00+05:30'],
    ]
    for (const [text, iso] of cases) expect(parseLimit(text, NOW)?.until?.toISOString()).toBe(at(iso).toISOString())
  })

  it('rolls a time already past over to tomorrow', () => {
    expect(parseLimit('5-hour limit reached ∙ resets 9am', NOW)?.until?.toISOString())
      .toBe(at('2026-11-01T09:00:00+05:30').toISOString())
  })

  it('knows the 5-hour wording and treats a reset that just passed as passed', () => {
    const at2 = at('2026-11-01T14:01:00+05:30')
    const r = parseLimit("You've hit your 5-hour limit · resets 2pm (Asia/Kolkata)", at2)
    expect(r?.until?.toISOString()).toBe(at('2026-11-01T14:00:00+05:30').toISOString())
    expect(blockedUntil({ until: r!.until!.toISOString(), since: at2.toISOString(), source: 'agent' }, at2)).toBeNull()
  })

  it('reads the epoch form from headless runs', () => {
    expect(parseLimit('Claude AI usage limit reached|1761921000', NOW)?.until?.getTime()).toBe(1761921000 * 1000)
  })

  it('knows a limit without a reset time', () => {
    expect(parseLimit('Claude usage limit reached.', NOW)).toEqual({ until: null })
  })
})

describe('blockedUntil', () => {
  it('blocks until the reset, or an hour when the reset is unknown', () => {
    const s = { until: '2026-10-31T19:00:00+05:30', since: NOW.toISOString(), source: 'runner' }
    expect(blockedUntil(s, NOW)?.toISOString()).toBe(at(s.until).toISOString())
    expect(blockedUntil(s, at('2026-10-31T19:00:01+05:30'))).toBeNull()
    const unknown = { until: null, since: NOW.toISOString(), source: 'agent' }
    expect(blockedUntil(unknown, at('2026-10-31T14:30:00+05:30'))).not.toBeNull()
    expect(blockedUntil(unknown, at('2026-10-31T15:06:00+05:30'))).toBeNull()
    expect(blockedUntil(null, NOW)).toBeNull()
  })
})
