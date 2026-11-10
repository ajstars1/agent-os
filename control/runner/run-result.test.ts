import { describe, expect, test } from 'bun:test'
import { decideOutcome, isStalled, parseRunResult, RETRY_MS, STALL_LIMIT, stallStreak } from '../lib/run-result'

const run = (status: string, summary: string | null = null): { status: string; summary: string | null } => ({ status, summary })

describe('stall rule', () => {
  test('three runs in a row without a result is a stall, two is not', () => {
    expect(STALL_LIMIT).toBe(3)
    expect(isStalled([run('blocked'), run('blocked'), run('blocked')])).toBe(true)
    expect(isStalled([run('blocked'), run('blocked')])).toBe(false)
  })
  test('blocked, error, timeout and unverified all count', () => {
    expect(stallStreak([run('unverified'), run('timeout'), run('error', 'stopped: error_max_turns'), run('blocked')])).toBe(4)
  })
  test('an ok run ends the streak', () => {
    expect(stallStreak([run('blocked'), run('blocked'), run('ok'), run('blocked'), run('blocked')])).toBe(2)
    expect(isStalled([run('ok'), run('blocked'), run('blocked'), run('blocked')])).toBe(false)
  })
  test('preflight skips and usage-limit stops neither count nor break the streak', () => {
    const rows = [run('blocked'), run('skipped', 'preflight: Chrome down'), run('error', 'usage limit, resets 3:30 pm'), run('blocked'), run('running'), run('blocked')]
    expect(stallStreak(rows)).toBe(3)
    expect(isStalled([run('error', 'usage limit, resets 3:30 pm'), run('error', 'usage limit, resets 8:30 pm'), run('error', 'usage limit')])).toBe(false)
  })
  test('no runs is no stall', () => {
    expect(stallStreak([])).toBe(0)
  })
})

describe('parseRunResult', () => {
  test('reads the last AOS_RESULT line', () => {
    const text = 'Did things.\nAOS_RESULT {"status":"failed","summary":"first"}\nmore\nAOS_RESULT {"status":"done","summary":"sent 3 notes"}'
    expect(parseRunResult(text)).toEqual({ status: 'done', summary: 'sent 3 notes' })
  })
  test('accepts backticks and a colon', () => {
    expect(parseRunResult('`AOS_RESULT: {"status":"blocked","summary":"LinkedIn logged out"}`')).toEqual({
      status: 'blocked',
      summary: 'LinkedIn logged out',
    })
  })
  test('falls back to an earlier valid line when the last is malformed', () => {
    expect(parseRunResult('AOS_RESULT {"status":"done","summary":"ok"}\nAOS_RESULT {oops')?.status).toBe('done')
  })
  test('rejects unknown status, empty summary, prose and missing input', () => {
    expect(parseRunResult('AOS_RESULT {"status":"ok","summary":"x"}')).toBeNull()
    expect(parseRunResult('AOS_RESULT {"status":"done","summary":"  "}')).toBeNull()
    expect(parseRunResult('All done, the task is complete.')).toBeNull()
    expect(parseRunResult(undefined)).toBeNull()
  })
})

describe('decideOutcome', () => {
  const base = { exitOk: true, timedOut: false, statusAfter: 'doing', result: null, runId: 7 }

  test('exit 0 with nothing else is unverified and goes back to todo', () => {
    const o = decideOutcome(base)
    expect(o.run).toBe('unverified')
    expect(o.task).toEqual({ kind: 'todo', note: expect.stringContaining('unverified'), retryMs: RETRY_MS })
  })
  test('task_done by Claude is ok and left alone', () => {
    expect(decideOutcome({ ...base, statusAfter: 'done' })).toEqual({ run: 'ok', task: { kind: 'leave' } })
  })
  test('an AOS_RESULT done line closes the task', () => {
    const o = decideOutcome({ ...base, result: { status: 'done', summary: 'drafted 2' } })
    expect(o).toEqual({ run: 'ok', task: { kind: 'done', note: 'runner: drafted 2' } })
  })
  test('blocked result goes back to todo and the run is blocked', () => {
    const o = decideOutcome({ ...base, result: { status: 'blocked', summary: 'Gmail logged out' } })
    expect(o.run).toBe('blocked')
    expect(o.task.kind).toBe('todo')
  })
  test('failed result is an error', () => {
    expect(decideOutcome({ ...base, result: { status: 'failed', summary: 'x' } }).run).toBe('error')
  })
  test('Claude moving the task back to todo itself counts as blocked, and its due time is pushed', () => {
    expect(decideOutcome({ ...base, statusAfter: 'todo' })).toEqual({ run: 'blocked', task: { kind: 'defer', retryMs: RETRY_MS } })
  })
  test('a task Claude left in todo is deferred on every kind of ending, never left due', () => {
    const defer = { kind: 'defer', retryMs: RETRY_MS }
    const todo = { ...base, statusAfter: 'todo' }
    expect(decideOutcome({ ...todo, result: { status: 'blocked', summary: 'no posts fit' } })).toEqual({ run: 'blocked', task: defer })
    expect(decideOutcome({ ...todo, result: { status: 'failed', summary: 'x' } })).toEqual({ run: 'error', task: defer })
    expect(decideOutcome({ ...todo, result: { status: 'done', summary: 'x' } })).toEqual({ run: 'ok', task: defer })
    expect(decideOutcome({ ...todo, exitOk: false })).toEqual({ run: 'error', task: defer })
    expect(decideOutcome({ ...todo, timedOut: true })).toEqual({ run: 'timeout', task: defer })
  })
  test('a task Claude closed or parked for approval is left alone', () => {
    expect(decideOutcome({ ...base, statusAfter: 'waiting_approval' }).task).toEqual({ kind: 'leave' })
    expect(decideOutcome({ ...base, statusAfter: 'skipped', exitOk: false }).task).toEqual({ kind: 'leave' })
  })
  test('waiting_approval set by Claude is ok', () => {
    expect(decideOutcome({ ...base, statusAfter: 'waiting_approval' }).run).toBe('ok')
  })
  test('a done line does not rescue a non-zero exit or a timeout', () => {
    const done = { status: 'done' as const, summary: 'x' }
    expect(decideOutcome({ ...base, exitOk: false, result: done }).run).toBe('error')
    expect(decideOutcome({ ...base, timedOut: true, result: done }).run).toBe('timeout')
  })
})
