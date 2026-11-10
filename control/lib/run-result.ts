// A runner task counts as done only when the run proves it: it called task_done itself, or it ended with
// a structured result line. Exit code 0 alone proves nothing (Phase 0 of notes/aos-plan-v2.md).
import { z } from 'zod'

export const RESULT_TAG = 'AOS_RESULT'

const resultSchema = z.object({
  status: z.enum(['done', 'blocked', 'failed']),
  summary: z.string().trim().min(1).max(2000),
})

export type RunResult = z.infer<typeof resultSchema>

// The last `AOS_RESULT {json}` line wins; anything malformed is ignored (the run is then unverified).
export const parseRunResult = (text: string | null | undefined): RunResult | null => {
  if (!text) return null
  const lines = text.split('\n').map((l) => l.trim().replace(/^`+|`+$/g, ''))
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.startsWith(RESULT_TAG)) continue
    const raw = line.slice(RESULT_TAG.length).trim().replace(/^:\s*/, '')
    try {
      const parsed = resultSchema.safeParse(JSON.parse(raw))
      if (parsed.success) return parsed.data
    } catch {
      // not JSON; keep looking at earlier lines
    }
  }
  return null
}

export type RunStatus = 'ok' | 'error' | 'timeout' | 'unverified' | 'blocked'

export type TaskAction =
  | { kind: 'leave' } // Claude already settled the task (task_done, or task_update to waiting_approval)
  | { kind: 'done'; note: string }
  | { kind: 'todo'; note: string; retryMs: number }
  // Claude put the task back to todo itself. Its due time is still in the past, so without a push the very
  // next tick would run it again (task #114 ran 48 times this way on 3-4 Nov). Never moves a due time earlier.
  | { kind: 'defer'; retryMs: number }

export interface Outcome {
  run: RunStatus
  task: TaskAction
}

export const RETRY_MS = 60 * 60 * 1000

// Decides the run row status and what to do with the task after a run.
// statusAfter is the task's status re-read after the run; 'doing' means Claude did not touch it.
export const decideOutcome = (input: {
  exitOk: boolean
  timedOut: boolean
  statusAfter: string
  result: RunResult | null
  runId: number | null
}): Outcome => {
  const { exitOk, timedOut, statusAfter, result, runId } = input
  const runRef = `run ${runId ?? '?'}`
  const claudeSettled = statusAfter !== 'doing'
  // What to do when Claude changed the task's status itself: a task it left in todo is still due, so push it.
  const settled: TaskAction = statusAfter === 'todo' ? { kind: 'defer', retryMs: RETRY_MS } : { kind: 'leave' }

  if (timedOut) {
    return {
      run: 'timeout',
      task: claudeSettled ? settled : { kind: 'todo', note: `${runRef} timed out, retry in 1 h`, retryMs: RETRY_MS },
    }
  }
  if (!exitOk) {
    return {
      run: 'error',
      task: claudeSettled ? settled : { kind: 'todo', note: `${runRef} failed, retry in 1 h`, retryMs: RETRY_MS },
    }
  }
  if (statusAfter === 'done' || statusAfter === 'skipped') return { run: 'ok', task: { kind: 'leave' } }
  if (result?.status === 'blocked') {
    return {
      run: 'blocked',
      task: claudeSettled ? settled : { kind: 'todo', note: `${runRef} blocked: ${result.summary}`, retryMs: RETRY_MS },
    }
  }
  if (result?.status === 'failed') {
    return {
      run: 'error',
      task: claudeSettled ? settled : { kind: 'todo', note: `${runRef} failed: ${result.summary}`, retryMs: RETRY_MS },
    }
  }
  if (result?.status === 'done') {
    return { run: 'ok', task: claudeSettled ? settled : { kind: 'done', note: `runner: ${result.summary}` } }
  }
  // Claude moved the task itself: back to todo means it was blocked; waiting_approval means a draft is queued.
  if (claudeSettled) return { run: statusAfter === 'todo' ? 'blocked' : 'ok', task: settled }
  return {
    run: 'unverified',
    task: { kind: 'todo', note: `unverified: ${runRef} exited 0 without task_done or an ${RESULT_TAG} line, retry in 1 h`, retryMs: RETRY_MS },
  }
}

// Stall rule (plan v2 §2.2): a task whose last STALL_LIMIT spawned runs all ended without a result is paused
// and handed to Ayush, whatever the reason. The preflight's own "two identical blocks" rule only covers runs
// that never spawned.
export const STALL_LIMIT = 3

const NO_RESULT: ReadonlySet<string> = new Set(['blocked', 'error', 'timeout', 'unverified'])

// A run cut short by Claude's usage limit says nothing about the task.
const isUsageLimit = (r: { status: string; summary: string | null }): boolean =>
  r.status === 'error' && (r.summary ?? '').startsWith('usage limit')

// rows: the task's runs, newest first. Counts the unbroken streak of runs with no result. Preflight skips
// (no spawn) and usage-limit stops neither count nor break the streak; an ok run ends it.
export const stallStreak = (rows: ReadonlyArray<{ status: string; summary: string | null }>): number => {
  let streak = 0
  for (const r of rows) {
    if (r.status === 'skipped' || r.status === 'running' || isUsageLimit(r)) continue
    if (!NO_RESULT.has(r.status)) break
    streak++
  }
  return streak
}

export const isStalled = (rows: ReadonlyArray<{ status: string; summary: string | null }>): boolean =>
  stallStreak(rows) >= STALL_LIMIT
