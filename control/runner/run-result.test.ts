import { describe, expect, test } from 'bun:test'
import { decideOutcome, parseRunResult, RETRY_MS } from '../lib/run-result'

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
  test('Claude moving the task back to todo itself counts as blocked, not ok', () => {
    expect(decideOutcome({ ...base, statusAfter: 'todo' })).toEqual({ run: 'blocked', task: { kind: 'leave' } })
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
