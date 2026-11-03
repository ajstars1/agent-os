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
  | { kind: 'leave' } // Claude already settled the task (task_done, or task_update away from doing)
  | { kind: 'done'; note: string }
  | { kind: 'todo'; note: string; retryMs: number }

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

  if (timedOut) {
    return {
      run: 'timeout',
      task: claudeSettled ? { kind: 'leave' } : { kind: 'todo', note: `${runRef} timed out, retry in 1 h`, retryMs: RETRY_MS },
    }
  }
  if (!exitOk) {
    return {
      run: 'error',
      task: claudeSettled ? { kind: 'leave' } : { kind: 'todo', note: `${runRef} failed, retry in 1 h`, retryMs: RETRY_MS },
    }
  }
  if (statusAfter === 'done' || statusAfter === 'skipped') return { run: 'ok', task: { kind: 'leave' } }
  if (result?.status === 'blocked') {
    return {
      run: 'blocked',
      task: claudeSettled ? { kind: 'leave' } : { kind: 'todo', note: `${runRef} blocked: ${result.summary}`, retryMs: RETRY_MS },
    }
  }
  if (result?.status === 'failed') {
    return {
      run: 'error',
      task: claudeSettled ? { kind: 'leave' } : { kind: 'todo', note: `${runRef} failed: ${result.summary}`, retryMs: RETRY_MS },
    }
  }
  if (result?.status === 'done') {
    return { run: 'ok', task: claudeSettled ? { kind: 'leave' } : { kind: 'done', note: `runner: ${result.summary}` } }
  }
  // Claude moved the task itself: back to todo means it was blocked; waiting_approval means a draft is queued.
  if (claudeSettled) return { run: statusAfter === 'todo' ? 'blocked' : 'ok', task: { kind: 'leave' } }
  return {
    run: 'unverified',
    task: { kind: 'todo', note: `unverified: ${runRef} exited 0 without task_done or an ${RESULT_TAG} line, retry in 1 h`, retryMs: RETRY_MS },
  }
}
