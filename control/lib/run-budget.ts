// Proactive throttle for unattended runs (idea from ethanplusai/harvey): leave headroom in Claude's
// 5-hour window for Ayush's own work instead of running until the hard limit hits (31 Oct: 6 runs
// failed on the limit). Budget = runs and cost the runner itself started in the last 5 hours.
// Tunable in .env.local: AOS_RUNNER_MAX_RUNS_5H (default 10), AOS_RUNNER_MAX_USD_5H (default 15).

export const WINDOW_MS = 5 * 60 * 60 * 1000

export interface RecentRun {
  started_at: string
  cost_usd: number | null
}

export interface BudgetLimits {
  maxRuns: number
  maxUsd: number
}

export interface BudgetVerdict {
  ok: boolean
  runs: number
  usd: number
  // when the oldest run counted leaves the window, i.e. the earliest a new run may start
  freeAt: Date | null
}

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const budgetLimits = (env: Record<string, string | undefined> = process.env): BudgetLimits => ({
  maxRuns: positive(env.AOS_RUNNER_MAX_RUNS_5H, 10),
  maxUsd: positive(env.AOS_RUNNER_MAX_USD_5H, 15),
})

export const checkBudget = (runs: RecentRun[], limits: BudgetLimits, now: Date): BudgetVerdict => {
  const since = now.getTime() - WINDOW_MS
  const inWindow = runs
    .filter((r) => new Date(r.started_at).getTime() >= since)
    .sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime())
  const usd = inWindow.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0)
  const ok = inWindow.length < limits.maxRuns && usd < limits.maxUsd
  const oldest = inWindow[0]
  const freeAt = ok || !oldest ? null : new Date(new Date(oldest.started_at).getTime() + WINDOW_MS)
  return { ok, runs: inWindow.length, usd: Math.round(usd * 100) / 100, freeAt }
}
