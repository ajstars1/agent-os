import { describe, expect, test } from 'bun:test'
import type { ServerContext } from '@modelcontextprotocol/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { agendaWindow, buildAgenda, formatAgenda, goalLine, goalPace } from '../lib/agenda'
import { isValidRecur, nextDue } from '../lib/recur'
import { isAuthorizationId, safeNext } from '../lib/redirect'
import { addDays, dayStart, instantOf, isValidTimeZone, wallTime, weekdayCode } from '../lib/time'
import { RATE_LIMIT, run, toText } from '../lib/tools'
import type { Approval, Goal, Task } from '../lib/types'

const IST = 'Asia/Kolkata'
const NY = 'America/New_York'

describe('time zones', () => {
  test('start of day is midnight on the wall clock of that zone', () => {
    expect(dayStart(new Date('2026-11-10T04:40:00Z'), IST).toISOString()).toBe('2026-11-09T18:30:00.000Z')
    expect(dayStart(new Date('2026-11-10T04:40:00Z'), NY).toISOString()).toBe('2026-11-09T05:00:00.000Z')
    expect(dayStart(new Date('2026-11-10T04:40:00Z'), 'UTC').toISOString()).toBe('2026-11-10T00:00:00.000Z')
  })
  test('adding a day keeps the wall-clock time across a daylight-saving change', () => {
    // New York leaves daylight time on 1 Nov 2026: 9:00 stays 9:00, though the day is 25 hours long
    const before = new Date('2026-10-31T13:00:00Z') // 09:00 EDT
    const after = addDays(before, 1, NY)
    expect(after.toISOString()).toBe('2026-11-01T14:00:00.000Z') // 09:00 EST
    expect(wallTime(after, NY)).toMatchObject({ day: 1, hour: 9, minute: 0 })
    // and back in spring (8 Mar 2026): a 23-hour day
    expect(addDays(new Date('2026-03-07T14:00:00Z'), 1, NY).toISOString()).toBe('2026-03-08T13:00:00.000Z')
  })
  test('instantOf round-trips and rolls a day overflow into the next month', () => {
    const w = wallTime(new Date('2026-11-30T12:15:00Z'), IST)
    expect(instantOf(w, IST).toISOString()).toBe('2026-11-30T12:15:00.000Z')
    expect(instantOf({ ...w, day: w.day + 1 }, IST).toISOString()).toBe('2026-12-01T12:15:00.000Z')
  })
  test('weekday is read in the zone, not in UTC', () => {
    const d = new Date('2026-11-09T20:00:00Z') // Monday in UTC and New York, already Tuesday in India
    expect(weekdayCode(d, 'UTC')).toBe('MO')
    expect(weekdayCode(d, IST)).toBe('TU')
  })
  test('rejects unknown zones', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true)
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })
})

describe('repeating tasks', () => {
  const now = new Date('2026-11-10T06:00:00Z') // Tue 10 Nov, 11:30 IST
  test('grammar matches the database check', () => {
    for (const ok of ['daily', 'weekdays', 'every:3d', 'weekly:MO', 'weekly:MO,TH,SA']) expect(isValidRecur(ok)).toBe(true)
    for (const bad of ['hourly', 'every:d', 'every:1000d', 'weekly:', 'weekly:XX', 'daily ', 'WEEKDAYS']) expect(isValidRecur(bad)).toBe(false)
  })
  test('daily: the next one is strictly after now, at the same wall time', () => {
    expect(nextDue(new Date('2026-11-10T03:30:00Z'), 'daily', IST, now).toISOString()).toBe('2026-11-11T03:30:00.000Z')
    // finished three days late: it does not fire again at once
    expect(nextDue(new Date('2026-11-07T03:30:00Z'), 'daily', IST, now).toISOString()).toBe('2026-11-11T03:30:00.000Z')
  })
  test('weekdays skips the weekend in the user zone', () => {
    const fri = new Date('2026-11-13T03:30:00Z')
    expect(nextDue(fri, 'weekdays', IST, fri).toISOString()).toBe('2026-11-16T03:30:00.000Z')
  })
  test('weekly picks the next listed day', () => {
    const tue = new Date('2026-11-10T03:30:00Z')
    expect(nextDue(tue, 'weekly:MO,TH', IST, tue).toISOString()).toBe('2026-11-12T03:30:00.000Z')
  })
  test('every:3d steps three days', () => {
    const d = new Date('2026-11-10T03:30:00Z')
    expect(nextDue(d, 'every:3d', IST, d).toISOString()).toBe('2026-11-13T03:30:00.000Z')
  })
  test('an invalid pattern throws', () => {
    expect(() => nextDue(now, 'hourly', IST, now)).toThrow('Invalid recur')
  })
})

const task = (over: Partial<Task>): Task => ({
  id: 1, title: 'A task', area: 'general', owner: 'me', status: 'todo', due_at: null, recur: null, notes: null,
  goal_id: null, parent_id: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...over,
})
const goal = (over: Partial<Goal>): Goal => ({
  id: 1, title: 'Ten orders', area: 'shop', unit: 'orders', target: 10, current: 0, due_at: '2026-11-21T00:00:00Z',
  status: 'active', created_at: '2026-11-01T00:00:00Z', ...over,
})

describe('agenda', () => {
  const now = new Date('2026-11-10T06:00:00Z') // Tue 10 Nov 11:30 IST; today in IST is 9 Nov 18:30Z .. 10 Nov 18:30Z
  const w = agendaWindow(now, IST, 3)

  test('tasks fall into overdue, today and coming up by the user day', () => {
    const tasks = [
      task({ id: 1, due_at: '2026-11-09T18:29:00Z' }), // 23:59 IST yesterday
      task({ id: 2, due_at: '2026-11-09T18:30:00Z' }), // 00:00 IST today
      task({ id: 3, due_at: '2026-11-10T18:29:59Z' }), // 23:59 IST today
      task({ id: 4, due_at: '2026-11-10T18:30:00Z' }), // tomorrow
      task({ id: 5, due_at: '2026-11-20T00:00:00Z' }), // outside the 3-day window
      task({ id: 6 }),
    ]
    const a = buildAgenda({ tasks, approvals: [], events: [], goals: [] }, w)
    expect(a.overdue.map((t) => t.id)).toEqual([1])
    expect(a.today.map((t) => t.id)).toEqual([2, 3])
    expect(a.upcoming.map((t) => t.id)).toEqual([4])
    expect(a.undated.map((t) => t.id)).toEqual([6])
  })

  test('the same instant is "today" in one zone and "overdue" in another', () => {
    const t = [task({ id: 1, due_at: '2026-11-09T20:00:00Z' })]
    expect(buildAgenda({ tasks: t, approvals: [], events: [], goals: [] }, agendaWindow(now, IST)).today).toHaveLength(1)
    expect(buildAgenda({ tasks: t, approvals: [], events: [], goals: [] }, agendaWindow(now, 'UTC')).overdue).toHaveLength(1)
  })

  test('goal pace: straight line between start and due date', () => {
    // 9 of 20 days gone, so about 4.5 of 10 expected
    expect(goalPace(goal({ current: 5 }), now).pace).toBe('on pace')
    expect(goalPace(goal({ current: 2 }), now)).toEqual({ pace: 'behind', expected: 4.6 })
    expect(goalPace(goal({ current: 10 }), now).pace).toBe('met')
    expect(goalPace(goal({ current: 3, due_at: '2026-11-08T00:00:00Z' }), now).pace).toBe('late')
    expect(goalPace(goal({ due_at: null }), now).pace).toBe('no date')
  })

  test('formatted agenda names what needs the person and how goals stand', () => {
    const approval: Approval = {
      id: 7, task_id: null, channel: 'email', recipient: 'client@example.com', draft: 'Hello, the quote is attached.',
      status: 'pending', result: null, send_after: null, created_at: '2026-11-10T05:00:00Z', decided_at: null,
    }
    const a = buildAgenda(
      { tasks: [task({ id: 2, title: 'Call the accountant', due_at: '2026-11-10T05:00:00Z' })], approvals: [approval], events: [], goals: [goal({ current: 2 }), goal({ id: 2, status: 'dropped' })] },
      w,
    )
    const text = formatAgenda(a, now, IST)
    expect(text).toContain('**Today (1)**')
    expect(text).toContain('#2 Call the accountant (Tue, 10 Nov, 10:30 am; you · general)')
    expect(text).toContain('approval #7 [email to client@example.com] Hello, the quote is attached.')
    expect(text).toContain('goal #1 Ten orders: 2 of 10 orders, due 21 Nov (behind: about 4.6 expected by now)')
    expect(text).not.toContain('goal #2')
    expect(formatAgenda(buildAgenda({ tasks: [], approvals: [], events: [], goals: [] }, w), now, IST)).toBe('Nothing open.')
    expect(goalLine(goal({ current: 5, unit: null, due_at: null }), now, IST)).toBe('goal #1 Ten orders: 5 of 10')
  })
})

describe('redirect guard', () => {
  test('keeps paths on this site', () => {
    expect(safeNext('/app')).toBe('/app')
    expect(safeNext('/oauth/consent?authorization_id=abc12345')).toBe('/oauth/consent?authorization_id=abc12345')
  })
  test('refuses anything that could leave the site', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 'app', '', '/a\nb', undefined, null, 7, '/' + 'x'.repeat(600)]) {
      expect(safeNext(bad)).toBe('/app')
    }
  })
  test('authorization ids are plain tokens', () => {
    expect(isAuthorizationId('3f2a9c1e-77aa-4d1b-9a55-0c1d2e3f4a5b')).toBe(true)
    for (const bad of ['', 'short', 'has space in it', '../../etc/passwd', 'a'.repeat(200), undefined]) expect(isAuthorizationId(bad)).toBe(false)
  })
})

describe('tool wrapper', () => {
  const ctx = (token?: string): ServerContext => ({ http: token ? { authInfo: { token, clientId: 'app', scopes: [] } } : undefined }) as unknown as ServerContext
  // a stand-in for the user's client: only the rate-limit call is answered
  const fake = (allowed: boolean, seen: string[] = []) => (token: string): SupabaseClient => {
    seen.push(token)
    return { rpc: async () => ({ data: allowed, error: null }) } as unknown as SupabaseClient
  }

  test('runs the tool with a client built from the request token', async () => {
    const seen: string[] = []
    const res = await run(async (_sb, a: { n: number }) => ({ doubled: a.n * 2 }), fake(true, seen))({ n: 4 }, ctx('tok-1'))
    expect(res.isError).toBeUndefined()
    expect(JSON.parse(res.content[0].text)).toEqual({ doubled: 8 })
    expect(seen).toEqual(['tok-1'])
  })
  test('no token on the request: refused before anything runs', async () => {
    let ran = false
    const res = await run(async () => { ran = true }, fake(true))({}, ctx())
    expect(res.isError).toBe(true)
    expect(ran).toBe(false)
  })
  test('over the rate limit: refused, tool not run', async () => {
    let ran = false
    const res = await run(async () => { ran = true }, fake(false))({}, ctx('tok'))
    expect(res).toEqual({ content: [{ type: 'text', text: 'Error: Too many requests. Wait a minute and try again.' }], isError: true })
    expect(ran).toBe(false)
    expect(RATE_LIMIT).toBeGreaterThan(0)
  })
  test('a thrown error becomes a readable tool error', async () => {
    const res = await run(async () => { throw new Error('Task 9 not found or already closed') }, fake(true))({}, ctx('tok'))
    expect(res).toEqual({ content: [{ type: 'text', text: 'Error: Task 9 not found or already closed' }], isError: true })
  })
  test('user_id and deleted_at never reach the assistant', () => {
    const text = toText({ id: 1, user_id: 'u-1', deleted_at: null, nested: [{ user_id: 'u-1', title: 'x' }] })
    expect(text).not.toContain('user_id')
    expect(text).not.toContain('deleted_at')
    expect(JSON.parse(text)).toEqual({ id: 1, nested: [{ title: 'x' }] })
  })
})
