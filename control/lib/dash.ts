// Read-only data for /dashboard. Server only (service role). Every query selects named columns and has a limit.
import { unstable_cache } from 'next/cache'
import { db, type Owner, type TaskStatus } from './db'
import { istDayStart, istYmd } from './time'
import { VENTURE_ORDER } from './ventures'

const DAY = 24 * 3600 * 1000
const OPEN: TaskStatus[] = ['todo', 'doing', 'waiting_approval']

export class DashboardDataError extends Error {
  constructor(
    public readonly query: string,
    message: string,
  ) {
    super(`${query}: ${message}`)
    this.name = 'DashboardDataError'
  }
}

type Res = { data: unknown; error: { message: string } | null }

const rows = <T>(name: string, res: Res): T[] => {
  if (res.error) throw new DashboardDataError(name, res.error.message)
  return (res.data ?? []) as T[]
}

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

// ---------- shapes ----------

export interface TaskRow {
  id: number
  title: string
  venture: string
  owner: Owner
  kind: string
  status: TaskStatus
  due_at: string | null
  recur: string | null
  auto: boolean
  notes: string | null
  updated_at: string
}

export interface ApprovalRow {
  id: number
  task_id: number | null
  channel: string
  recipient: string | null
  draft: string
  status: 'pending' | 'approved' | 'rejected' | 'sent' | 'failed'
  result: string | null
  created_at: string
  decided_at: string | null
  venture: string | null
  task_title: string | null
}

export interface ActivityRow {
  id: number
  at: string
  venture: string
  channel: string
  account: string
  action: string
  result: string | null
}

export interface RunRow {
  id: number
  task_id: number | null
  status: 'running' | 'ok' | 'error' | 'timeout'
  summary: string | null
  cost_usd: number | null
  started_at: string
  finished_at: string | null
  venture: string | null
  task_title: string | null
}

export interface GoalRow {
  id: number
  title: string
  venture: string
  target: number
  current: number
  start_value: number
  start_at: string
  due_at: string
}

export interface VentureStat {
  venture: string
  open: number
  overdue: number
  mine: number
  doneLast7: number
  touches7: number
  lastActivity: string | null
  goals: GoalRow[]
}

// ---------- column lists ----------

const TASK_COLS = 'id, title, venture, owner, kind, status, due_at, recur, auto, notes, updated_at'
const APPROVAL_COLS = 'id, task_id, channel, recipient, draft, status, result, created_at, decided_at'
const ACTIVITY_COLS = 'id, at, venture, channel, account, action, result'
const RUN_COLS = 'id, task_id, status, summary, cost_usd, started_at, finished_at'
const GOAL_COLS = 'id, title, venture, target, current, start_value, start_at, due_at'

const trimNotes = (t: TaskRow): TaskRow => ({ ...t, notes: t.notes ? t.notes.slice(-700) : null })

interface RawApproval extends Omit<ApprovalRow, 'venture' | 'task_title'> {
  tasks: { venture: string; title: string } | { venture: string; title: string }[] | null
}
const toApproval = ({ tasks, ...a }: RawApproval): ApprovalRow => {
  const t = one(tasks)
  return { ...a, venture: t?.venture ?? null, task_title: t?.title ?? null }
}

interface RawRun extends Omit<RunRow, 'venture' | 'task_title' | 'cost_usd'> {
  cost_usd: number | string | null
  tasks: { venture: string; title: string } | { venture: string; title: string }[] | null
}
const toRun = ({ tasks, ...r }: RawRun): RunRow => {
  const t = one(tasks)
  return {
    ...r,
    summary: r.summary ? r.summary.slice(0, 2500) : null,
    cost_usd: r.cost_usd === null ? null : Number(r.cost_usd),
    venture: t?.venture ?? null,
    task_title: t?.title ?? null,
  }
}

const toGoal = (g: GoalRow): GoalRow => ({
  ...g,
  target: Number(g.target),
  current: Number(g.current),
  start_value: Number(g.start_value),
})

// Expected value today on a straight line from (start_at, start_value) to (due_at, target).
export const goalPace = (g: GoalRow, now: Date): number => {
  const s = new Date(g.start_at).getTime()
  const e = new Date(g.due_at).getTime()
  if (e <= s) return g.target
  const f = Math.min(1, Math.max(0, (now.getTime() - s) / (e - s)))
  return g.start_value + (g.target - g.start_value) * f
}

const latest = (a: string | null, b: string | null): string | null => {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

const ventureStats = (
  open: TaskRow[],
  done: { venture: string; updated_at: string }[],
  activity: { venture: string; at: string; channel: string }[],
  goals: GoalRow[],
  now: Date,
): VentureStat[] => {
  const start = istDayStart(now)
  const weekAgo = now.getTime() - 7 * DAY
  const map = new Map<string, VentureStat>()
  const get = (v: string): VentureStat => {
    let s = map.get(v)
    if (!s) {
      s = { venture: v, open: 0, overdue: 0, mine: 0, doneLast7: 0, touches7: 0, lastActivity: null, goals: [] }
      map.set(v, s)
    }
    return s
  }
  for (const v of VENTURE_ORDER) if (v !== 'consultancy') get(v)
  for (const t of open) {
    const s = get(t.venture)
    s.open += 1
    if (t.due_at && new Date(t.due_at).getTime() < start) s.overdue += 1
    if (t.owner === 'ayush') s.mine += 1
    s.lastActivity = latest(s.lastActivity, t.updated_at)
  }
  for (const t of done) {
    const s = get(t.venture)
    s.doneLast7 += 1
    s.lastActivity = latest(s.lastActivity, t.updated_at)
  }
  for (const a of activity) {
    const s = get(a.venture)
    if (a.channel !== 'internal' && new Date(a.at).getTime() >= weekAgo) s.touches7 += 1
    s.lastActivity = latest(s.lastActivity, a.at)
  }
  for (const g of goals) get(g.venture).goals.push(g)
  const rank = (v: string): number => {
    const i = VENTURE_ORDER.indexOf(v)
    return i === -1 ? 99 : i
  }
  return [...map.values()].sort((a, b) => rank(a.venture) - rank(b.venture) || a.venture.localeCompare(b.venture))
}

// The activity log names contacts in free text ("Henson Orser, CEO Two Dots (YC S22)"); keep the name part
// so the same person counts once. Some rows name a company or a batch, so this counts contacts, not people.
export const contactKey = (account: string): string =>
  account
    .toLowerCase()
    .replace(/^(dr\.?|mr\.?|ms\.?)\s+/, '')
    .split(/[,(|]| - | — | – | via | at /)[0]
    .replace(/[^a-z0-9@. ]/g, '')
    .trim()

// ---------- Today ----------

export interface TodayData {
  now: string
  mine: TaskRow[]
  team: TaskRow[]
  aosDue: TaskRow[]
  approvals: ApprovalRow[]
  doneToday: { owner: Owner }[]
  runsToday: { count: number; ok: number; cost: number }
  touchesToday: number
  latest: ActivityRow[]
  ventures: VentureStat[]
}

export const loadToday = async (now: Date = new Date()): Promise<TodayData> => {
  const start = istDayStart(now)
  const startIso = new Date(start).toISOString()
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString()
  const monthAgo = new Date(now.getTime() - 30 * DAY).toISOString()
  const c = db()
  const [openR, apR, doneTodayR, done7R, runsR, actR, actVR, goalsR] = await Promise.all([
    c.from('tasks').select(TASK_COLS).is('deleted_at', null).in('status', OPEN).order('due_at', { ascending: true, nullsFirst: false }).limit(300),
    c.from('approvals').select(`${APPROVAL_COLS}, tasks(venture, title)`).is('deleted_at', null).eq('status', 'pending').order('id').limit(30),
    c.from('tasks').select('owner').is('deleted_at', null).eq('status', 'done').gte('updated_at', startIso).limit(300),
    c.from('tasks').select('venture, updated_at').is('deleted_at', null).eq('status', 'done').gte('updated_at', weekAgo).limit(500),
    c.from('runs').select('status, cost_usd').gte('started_at', startIso).limit(300),
    c.from('activity').select(ACTIVITY_COLS).order('at', { ascending: false }).limit(5),
    c.from('activity').select('venture, at, channel').gte('at', monthAgo).order('at', { ascending: false }).limit(500),
    c.from('goals').select(GOAL_COLS).is('deleted_at', null).eq('status', 'active').order('due_at').limit(20),
  ])
  const open = rows<TaskRow>('open tasks', openR).map(trimNotes)
  const due = open.filter((t) => t.due_at && new Date(t.due_at).getTime() < start + DAY)
  const runs = rows<{ status: string; cost_usd: number | string | null }>('runs today', runsR)
  const actV = rows<{ venture: string; at: string; channel: string }>('activity by venture', actVR)
  return {
    now: now.toISOString(),
    mine: due.filter((t) => t.owner === 'ayush'),
    team: due.filter((t) => t.owner !== 'ayush' && t.owner !== 'claude'),
    aosDue: due.filter((t) => t.owner === 'claude'),
    approvals: rows<RawApproval>('pending approvals', apR).map(toApproval),
    doneToday: rows<{ owner: Owner }>('done today', doneTodayR),
    runsToday: {
      count: runs.length,
      ok: runs.filter((r) => r.status === 'ok').length,
      cost: runs.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0),
    },
    touchesToday: actV.filter((a) => a.channel !== 'internal' && new Date(a.at).getTime() >= start).length,
    latest: rows<ActivityRow>('latest activity', actR),
    ventures: ventureStats(open, rows('done 7d', done7R), actV, rows<GoalRow>('goals', goalsR).map(toGoal), now),
  }
}

// ---------- Tasks ----------

export interface TasksData {
  now: string
  tasks: TaskRow[]
}

export const loadTasks = async (now: Date = new Date(), venture?: string): Promise<TasksData> => {
  const twoWeeks = new Date(now.getTime() - 14 * DAY).toISOString()
  const c = db()
  let openQ = c.from('tasks').select(TASK_COLS).is('deleted_at', null).in('status', OPEN).order('due_at', { ascending: true, nullsFirst: false }).limit(400)
  let closedQ = c.from('tasks').select(TASK_COLS).is('deleted_at', null).in('status', ['done', 'skipped']).gte('updated_at', twoWeeks).order('updated_at', { ascending: false }).limit(300)
  if (venture) {
    openQ = openQ.eq('venture', venture)
    closedQ = closedQ.eq('venture', venture)
  }
  const [openR, closedR] = await Promise.all([openQ, closedQ])
  return {
    now: now.toISOString(),
    tasks: [...rows<TaskRow>('open tasks', openR), ...rows<TaskRow>('closed tasks', closedR)].map(trimNotes),
  }
}

// ---------- Ventures ----------

export interface VenturesData {
  now: string
  ventures: VentureStat[]
}

export const loadVentures = async (now: Date = new Date()): Promise<VenturesData> => {
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString()
  const monthAgo = new Date(now.getTime() - 30 * DAY).toISOString()
  const c = db()
  const [openR, doneR, actR, goalsR] = await Promise.all([
    c.from('tasks').select(TASK_COLS).is('deleted_at', null).in('status', OPEN).limit(400),
    c.from('tasks').select('venture, updated_at').is('deleted_at', null).eq('status', 'done').gte('updated_at', weekAgo).limit(500),
    c.from('activity').select('venture, at, channel').gte('at', monthAgo).order('at', { ascending: false }).limit(500),
    c.from('goals').select(GOAL_COLS).is('deleted_at', null).eq('status', 'active').order('due_at').limit(20),
  ])
  return {
    now: now.toISOString(),
    ventures: ventureStats(
      rows<TaskRow>('open tasks', openR),
      rows('done 7d', doneR),
      rows('activity', actR),
      rows<GoalRow>('goals', goalsR).map(toGoal),
      now,
    ),
  }
}

export interface VentureData {
  now: string
  venture: string
  stat: VentureStat
  tasks: TaskRow[]
  activity: ActivityRow[]
  approvals: ApprovalRow[]
  runs: RunRow[]
  totals: { touches: number; people: number; sent: number; done: number; runs: number; cost: number }
}

export const loadVenture = async (venture: string, now: Date = new Date()): Promise<VentureData> => {
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString()
  const c = db()
  const [tasksData, actR, actAllR, apR, runsR, runTotR, doneAllR, goalsR] = await Promise.all([
    loadTasks(now, venture),
    c.from('activity').select(ACTIVITY_COLS).eq('venture', venture).order('at', { ascending: false }).limit(40),
    c.from('activity').select('account, channel, at').eq('venture', venture).limit(3000),
    c
      .from('approvals')
      .select(`${APPROVAL_COLS}, tasks!inner(venture, title)`)
      .is('deleted_at', null)
      .eq('tasks.venture', venture)
      .order('id', { ascending: false })
      .limit(25),
    c
      .from('runs')
      .select(`${RUN_COLS}, tasks!inner(venture, title)`)
      .eq('tasks.venture', venture)
      .order('started_at', { ascending: false })
      .limit(12),
    c.from('runs').select('cost_usd, tasks!inner(venture)').eq('tasks.venture', venture).limit(3000),
    c.from('tasks').select('updated_at').is('deleted_at', null).eq('venture', venture).eq('status', 'done').limit(3000),
    c.from('goals').select(GOAL_COLS).is('deleted_at', null).eq('status', 'active').eq('venture', venture).order('due_at').limit(10),
  ])
  const actAll = rows<{ account: string; channel: string; at: string }>('activity totals', actAllR).filter((a) => a.channel !== 'internal')
  const approvals = rows<RawApproval>('approvals', apR).map(toApproval)
  const runTot = rows<{ cost_usd: number | string | null }>('run totals', runTotR)
  const doneAll = rows<{ updated_at: string }>('done tasks', doneAllR)
  const open = tasksData.tasks.filter((t) => OPEN.includes(t.status))
  const [stat] = ventureStats(
    open,
    doneAll.filter((d) => d.updated_at >= weekAgo).map((d) => ({ venture, updated_at: d.updated_at })),
    actAll.map((a) => ({ venture, at: a.at, channel: a.channel })),
    rows<GoalRow>('goals', goalsR).map(toGoal),
    now,
  ).filter((s) => s.venture === venture)
  return {
    now: now.toISOString(),
    venture,
    stat: stat ?? { venture, open: 0, overdue: 0, mine: 0, doneLast7: 0, touches7: 0, lastActivity: null, goals: [] },
    tasks: tasksData.tasks,
    activity: rows<ActivityRow>('activity', actR),
    approvals,
    runs: rows<RawRun>('runs', runsR).map(toRun),
    totals: {
      touches: actAll.length,
      people: new Set(actAll.map((a) => contactKey(a.account))).size,
      sent: approvals.filter((a) => a.status === 'sent').length,
      done: doneAll.length,
      runs: runTot.length,
      cost: runTot.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0),
    },
  }
}

// ---------- Log ----------

export interface LogData {
  now: string
  activity: ActivityRow[]
  runs: RunRow[]
  approvals: ApprovalRow[]
}

export const loadLog = async (now: Date = new Date()): Promise<LogData> => {
  const c = db()
  const [actR, runsR, apR] = await Promise.all([
    c.from('activity').select(ACTIVITY_COLS).order('at', { ascending: false }).limit(60),
    c.from('runs').select(`${RUN_COLS}, tasks(venture, title)`).order('started_at', { ascending: false }).limit(20),
    c.from('approvals').select(`${APPROVAL_COLS}, tasks(venture, title)`).is('deleted_at', null).neq('status', 'pending').order('id', { ascending: false }).limit(25),
  ])
  return {
    now: now.toISOString(),
    activity: rows<ActivityRow>('activity', actR),
    runs: rows<RawRun>('runs', runsR).map(toRun),
    approvals: rows<RawApproval>('approvals', apR).map(toApproval),
  }
}

// ---------- Story (since day one; cached 30 min) ----------

export const channelGroup = (channel: string): string => {
  const c = channel.toLowerCase()
  if (c.startsWith('linkedin')) return 'LinkedIn'
  if (c === 'gmail' || c === 'email' || c === 'zoho') return 'Email'
  if (c === 'whatsapp') return 'WhatsApp'
  if (c === 'reddit') return 'Reddit'
  if (c === 'indiehackers') return 'Indie Hackers'
  if (c.startsWith('meta')) return 'Meta'
  if (c === 'in-person') return 'In person'
  if (c === 'internal') return 'Internal'
  return channel.charAt(0).toUpperCase() + channel.slice(1)
}

export interface DayPoint {
  day: string
  touches: number
  runs: number
  done: number
}

export interface StoryData {
  computedAt: string
  since: string
  days: number
  tasks: { total: number; done: number; doneByAos: number; ownedByAos: number; autoTasks: number }
  drafts: { total: number; approved: number; rejected: number; sent: number; failed: number; pending: number }
  outreach: { touches: number; people: number; conversations: number; channels: { name: string; count: number }[] }
  runs: { total: number; ok: number; limitHits: number; hours: number; cost: number }
  ventures: { venture: string; touches: number; done: number; drafts: number }[]
  daily: DayPoint[]
  goals: GoalRow[]
}

const computeStory = async (): Promise<StoryData> => {
  const now = new Date()
  const c = db()
  const [tR, aR, apR, rR, gR, limitR] = await Promise.all([
    c.from('tasks').select('venture, owner, status, auto, created_at, updated_at').is('deleted_at', null).order('created_at').limit(5000),
    c.from('activity').select('at, venture, channel, account').order('at').limit(5000),
    c.from('approvals').select('status, tasks(venture)').is('deleted_at', null).limit(5000),
    c.from('runs').select('status, cost_usd, started_at, finished_at').order('started_at').limit(5000),
    c.from('goals').select(GOAL_COLS).is('deleted_at', null).eq('status', 'active').order('due_at').limit(20),
    // runs the plan's usage limit stopped before they started work (summary is the CLI's limit notice)
    c.from('runs').select('id', { count: 'exact', head: true }).eq('status', 'error').ilike('summary', '%limit%'),
  ])
  if (limitR.error) throw new DashboardDataError('limit runs', limitR.error.message)
  const tasks = rows<{ venture: string; owner: Owner; status: TaskStatus; auto: boolean; created_at: string; updated_at: string }>('tasks', tR)
  const acts = rows<{ at: string; venture: string; channel: string; account: string }>('activity', aR)
  const aps = rows<{ status: ApprovalRow['status']; tasks: { venture: string } | { venture: string }[] | null }>('approvals', apR)
  const runs = rows<{ status: string; cost_usd: number | string | null; started_at: string; finished_at: string | null }>('runs', rR)

  const firstAt = [tasks[0]?.created_at, acts[0]?.at, runs[0]?.started_at].filter((x): x is string => Boolean(x)).sort()[0] ?? now.toISOString()
  const outreach = acts.filter((a) => a.channel !== 'internal')
  const perAccount = new Map<string, number>()
  for (const a of outreach) {
    const k = contactKey(a.account)
    perAccount.set(k, (perAccount.get(k) ?? 0) + 1)
  }
  const channels = new Map<string, number>()
  for (const a of outreach) channels.set(channelGroup(a.channel), (channels.get(channelGroup(a.channel)) ?? 0) + 1)

  const daily = new Map<string, DayPoint>()
  for (let t = istDayStart(new Date(firstAt)); t <= now.getTime(); t += DAY) {
    const day = istYmd(new Date(t + 6 * 3600 * 1000))
    daily.set(day, { day, touches: 0, runs: 0, done: 0 })
  }
  const bump = (iso: string, k: 'touches' | 'runs' | 'done'): void => {
    const p = daily.get(istYmd(new Date(iso)))
    if (p) p[k] += 1
  }
  for (const a of outreach) bump(a.at, 'touches')
  for (const r of runs) if (r.status === 'ok') bump(r.started_at, 'runs')
  for (const t of tasks) if (t.status === 'done') bump(t.updated_at, 'done')

  const ventures = new Map<string, { venture: string; touches: number; done: number; drafts: number }>()
  const vg = (v: string) => {
    let x = ventures.get(v)
    if (!x) {
      x = { venture: v, touches: 0, done: 0, drafts: 0 }
      ventures.set(v, x)
    }
    return x
  }
  for (const a of outreach) vg(a.venture).touches += 1
  for (const t of tasks) if (t.status === 'done') vg(t.venture).done += 1
  for (const a of aps) vg(one(a.tasks)?.venture ?? 'general').drafts += 1

  const decided = (s: ApprovalRow['status']): boolean => s !== 'pending'
  const approvedLike: ApprovalRow['status'][] = ['approved', 'sent', 'failed']

  return {
    computedAt: now.toISOString(),
    since: firstAt,
    days: Math.max(1, Math.round((istDayStart(now) - istDayStart(new Date(firstAt))) / DAY) + 1),
    tasks: {
      total: tasks.length,
      done: tasks.filter((t) => t.status === 'done').length,
      doneByAos: tasks.filter((t) => t.status === 'done' && t.owner === 'claude').length,
      ownedByAos: tasks.filter((t) => t.owner === 'claude').length,
      autoTasks: tasks.filter((t) => t.auto).length,
    },
    drafts: {
      total: aps.length,
      approved: aps.filter((a) => approvedLike.includes(a.status)).length,
      rejected: aps.filter((a) => a.status === 'rejected').length,
      sent: aps.filter((a) => a.status === 'sent').length,
      failed: aps.filter((a) => a.status === 'failed').length,
      pending: aps.filter((a) => !decided(a.status)).length,
    },
    outreach: {
      touches: outreach.length,
      people: perAccount.size,
      conversations: [...perAccount.values()].filter((n) => n >= 2).length,
      channels: [...channels.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    },
    runs: {
      total: runs.length,
      ok: runs.filter((r) => r.status === 'ok').length,
      limitHits: limitR.count ?? 0,
      hours:
        runs.reduce((s, r) => s + (r.finished_at ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime() : 0), 0) /
        3600000,
      cost: runs.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0),
    },
    ventures: [...ventures.values()].sort((a, b) => b.touches + b.done - (a.touches + a.done)),
    daily: [...daily.values()],
    goals: rows<GoalRow>('goals', gR).map(toGoal),
  }
}

export const loadStory = unstable_cache(computeStory, ['aos-story-v4'], { revalidate: 1800 })
