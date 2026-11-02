// Read-only data for /dashboard. One parallel batch of small, limited queries per page view.
import { db, type Approval, type Owner, type Run, type TaskStatus } from './db'
import { startOfTodayIst } from './tasks'

const DAY = 24 * 3600 * 1000
const OPEN: TaskStatus[] = ['todo', 'doing', 'waiting_approval']
export const KNOWN_VENTURES = ['0unveiled', 'gkt', 'dawnwell', 'aos', 'linkedin', 'general'] as const

export class DashboardDataError extends Error {
  constructor(
    public readonly query: string,
    message: string,
  ) {
    super(`${query}: ${message}`)
    this.name = 'DashboardDataError'
  }
}

export interface OpenTask {
  id: number
  title: string
  venture: string
  owner: Owner
  status: TaskStatus
  due_at: string | null
  recur: string | null
  auto: boolean
  updated_at: string
}

export interface ActivityRow {
  id: number
  at: string
  venture: string
  channel: string
  account: string
  action: string
  result: string | null
  task_id: number | null
}

export interface RunRow extends Run {
  task: { title: string; venture: string } | null
}

export interface VentureCard {
  venture: string
  open: number
  overdue: number
  doneLast7: number
  lastActivity: string | null
}

export interface TaskGroup {
  venture: string
  owners: { owner: Owner; tasks: OpenTask[] }[]
}

export interface DashboardData {
  generatedAt: string
  overdue: TaskGroup[]
  today: TaskGroup[]
  upcoming: TaskGroup[]
  undated: TaskGroup[]
  counts: { overdue: number; today: number; upcoming: number; undated: number }
  pendingApprovals: Approval[]
  recentApprovals: Approval[]
  ventures: VentureCard[]
  activity: ActivityRow[]
  runs: RunRow[]
  runCost7d: { total: number; runs: number }
}

type Res<T> = { data: T | null; error: { message: string } | null }

const rows = <T>(name: string, res: Res<unknown>): T[] => {
  if (res.error) throw new DashboardDataError(name, res.error.message)
  return (res.data ?? []) as T[]
}

const OWNER_ORDER: Owner[] = ['ayush', 'claude', 'shiven', 'mayank', 'family']

export const groupTasks = (tasks: OpenTask[]): TaskGroup[] => {
  const byVenture = new Map<string, Map<Owner, OpenTask[]>>()
  for (const t of tasks) {
    const owners = byVenture.get(t.venture) ?? new Map<Owner, OpenTask[]>()
    owners.set(t.owner, [...(owners.get(t.owner) ?? []), t])
    byVenture.set(t.venture, owners)
  }
  return [...byVenture.entries()]
    .map(([venture, owners]) => ({
      venture,
      owners: [...owners.entries()]
        .sort((a, b) => OWNER_ORDER.indexOf(a[0]) - OWNER_ORDER.indexOf(b[0]))
        .map(([owner, list]) => ({ owner, tasks: list })),
    }))
    .sort((a, b) => count(b) - count(a) || a.venture.localeCompare(b.venture))
}

const count = (g: TaskGroup): number => g.owners.reduce((n, o) => n + o.tasks.length, 0)

const latest = (a: string | null, b: string | null): string | null => {
  if (!a) return b
  if (!b) return a
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b
}

interface RawRun extends Run {
  tasks: { title: string; venture: string } | { title: string; venture: string }[] | null
}

export const loadDashboard = async (now: Date = new Date()): Promise<DashboardData> => {
  const start = startOfTodayIst(now).getTime()
  const endToday = start + DAY
  const endUpcoming = start + 8 * DAY
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString()
  const monthAgo = new Date(now.getTime() - 30 * DAY).toISOString()

  const c = db()
  const [openRes, doneRes, pendingRes, recentApRes, activityRes, ventureActRes, runsRes, costRes] = await Promise.all([
    c
      .from('tasks')
      .select('id, title, venture, owner, status, due_at, recur, auto, updated_at')
      .is('deleted_at', null)
      .in('status', OPEN)
      .order('due_at', { ascending: true, nullsFirst: false })
      .limit(300),
    c.from('tasks').select('venture, updated_at').is('deleted_at', null).eq('status', 'done').gte('updated_at', weekAgo).limit(500),
    c
      .from('approvals')
      .select('id, task_id, channel, recipient, draft, status, result, created_at, decided_at')
      .is('deleted_at', null)
      .eq('status', 'pending')
      .order('id', { ascending: true })
      .limit(50),
    c
      .from('approvals')
      .select('id, task_id, channel, recipient, draft, status, result, created_at, decided_at')
      .is('deleted_at', null)
      .in('status', ['approved', 'sent', 'failed'])
      .order('id', { ascending: false })
      .limit(20),
    c
      .from('activity')
      .select('id, at, venture, channel, account, action, result, task_id')
      .order('at', { ascending: false })
      .limit(40),
    c.from('activity').select('venture, at').gte('at', monthAgo).order('at', { ascending: false }).limit(400),
    c
      .from('runs')
      .select('id, task_id, trigger, status, summary, session_id, cost_usd, started_at, finished_at, tasks(title, venture)')
      .order('started_at', { ascending: false })
      .limit(15),
    c.from('runs').select('cost_usd').gte('started_at', weekAgo).limit(1000),
  ])

  const open = rows<OpenTask>('open tasks', openRes)
  const done = rows<{ venture: string; updated_at: string }>('done tasks', doneRes)
  const ventureAct = rows<{ venture: string; at: string }>('activity by venture', ventureActRes)
  const cost = rows<{ cost_usd: number | string | null }>('run cost', costRes)

  const due = (t: OpenTask): number => (t.due_at ? new Date(t.due_at).getTime() : Number.NaN)
  const overdue = open.filter((t) => due(t) < start)
  const today = open.filter((t) => due(t) >= start && due(t) < endToday)
  const upcoming = open.filter((t) => due(t) >= endToday && due(t) < endUpcoming)
  const undated = open.filter((t) => !t.due_at)

  const cards = new Map<string, VentureCard>()
  const card = (v: string): VentureCard => {
    const existing = cards.get(v)
    if (existing) return existing
    const fresh: VentureCard = { venture: v, open: 0, overdue: 0, doneLast7: 0, lastActivity: null }
    cards.set(v, fresh)
    return fresh
  }
  for (const v of KNOWN_VENTURES) card(v)
  for (const t of open) {
    const k = card(t.venture)
    k.open += 1
    if (due(t) < start) k.overdue += 1
    k.lastActivity = latest(k.lastActivity, t.updated_at)
  }
  for (const t of done) {
    const k = card(t.venture)
    k.doneLast7 += 1
    k.lastActivity = latest(k.lastActivity, t.updated_at)
  }
  for (const a of ventureAct) {
    const k = card(a.venture)
    k.lastActivity = latest(k.lastActivity, a.at)
  }

  const runs = rows<RawRun>('runs', runsRes).map(({ tasks, ...r }) => ({
    ...r,
    cost_usd: r.cost_usd === null ? null : Number(r.cost_usd),
    task: Array.isArray(tasks) ? (tasks[0] ?? null) : tasks,
  }))

  return {
    generatedAt: now.toISOString(),
    overdue: groupTasks(overdue),
    today: groupTasks(today),
    upcoming: groupTasks(upcoming),
    undated: groupTasks(undated),
    counts: { overdue: overdue.length, today: today.length, upcoming: upcoming.length, undated: undated.length },
    pendingApprovals: rows<Approval>('pending approvals', pendingRes),
    recentApprovals: rows<Approval>('recent approvals', recentApRes),
    ventures: [...cards.values()].sort(
      (a, b) => b.overdue - a.overdue || b.open - a.open || b.doneLast7 - a.doneLast7 || a.venture.localeCompare(b.venture),
    ),
    activity: rows<ActivityRow>('activity', activityRes),
    runs,
    runCost7d: {
      total: cost.reduce((s, r) => s + (r.cost_usd === null ? 0 : Number(r.cost_usd) || 0), 0),
      runs: cost.length,
    },
  }
}
