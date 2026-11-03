import { db, type Approval, type CalendarEvent, type Kind, type Owner, type Task, type TaskStatus } from './db'
import { notify } from './discord'
import { isValidRecur, nextDue } from './recur'
import { recordTouch } from './touches'

const OPEN: TaskStatus[] = ['todo', 'doing', 'waiting_approval']
const IST = 'Asia/Kolkata'

export interface NewTask {
  title: string
  venture?: string
  owner?: Owner
  kind?: Kind
  due_at?: string | null
  recur?: string | null
  prompt?: string | null
  cwd?: string | null
  source?: string | null
  notes?: string | null
  auto?: boolean
}

export type TaskPatch = Partial<NewTask> & { status?: TaskStatus }

export interface TaskFilter {
  status?: TaskStatus[]
  owner?: Owner
  venture?: string
  query?: string
  dueBefore?: string
  limit?: number
}

const check = <T>(res: { data: T | null; error: { message: string } | null }): T => {
  if (res.error) throw new Error(res.error.message)
  if (res.data === null) throw new Error('Not found')
  return res.data
}

const validate = (t: Partial<NewTask>): void => {
  if (t.recur && !isValidRecur(t.recur)) {
    throw new Error(`recur must be daily | weekdays | weekly:MO,TH | every:3d (got "${t.recur}")`)
  }
  if (t.recur && !t.due_at) throw new Error('A recurring task needs due_at')
  if (t.auto && t.owner && t.owner !== 'claude') throw new Error('Only owner "claude" tasks can be auto')
}

// Start of today in IST, as an ISO instant.
export const startOfTodayIst = (now: Date = new Date()): Date => {
  const ymd = now.toLocaleDateString('en-CA', { timeZone: IST })
  return new Date(`${ymd}T00:00:00+05:30`)
}

export const fmtIst = (iso: string | null): string => {
  if (!iso) return 'no date'
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: IST,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export const listTasks = async (f: TaskFilter = {}): Promise<Task[]> => {
  let q = db()
    .from('tasks')
    .select('*')
    .is('deleted_at', null)
    .in('status', f.status ?? OPEN)
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(f.limit ?? 100)
  if (f.owner) q = q.eq('owner', f.owner)
  if (f.venture) q = q.eq('venture', f.venture)
  if (f.dueBefore) q = q.lte('due_at', f.dueBefore)
  if (f.query) q = q.ilike('title', `%${f.query.replace(/[%_]/g, '')}%`)
  return check(await q) as Task[]
}

export const getTask = async (id: number): Promise<Task> =>
  check(await db().from('tasks').select('*').eq('id', id).is('deleted_at', null).single()) as Task

export const addTask = async (t: NewTask): Promise<Task> => {
  validate(t)
  return check(await db().from('tasks').insert(t).select('*').single()) as Task
}

export const updateTask = async (id: number, patch: TaskPatch): Promise<Task> => {
  const current = await getTask(id)
  validate({ ...current, ...patch })
  return check(await db().from('tasks').update(patch).eq('id', id).select('*').single()) as Task
}

// Soft delete only.
export const deleteTask = async (id: number): Promise<Task> =>
  check(
    await db().from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', id).select('*').single(),
  ) as Task

// Marks a task done or skipped; a recurring task gets its next occurrence created.
export const closeTask = async (
  id: number,
  status: 'done' | 'skipped',
  note?: string,
): Promise<{ closed: Task; next: Task | null }> => {
  const t = await getTask(id)
  const notes = note ? [t.notes, `${status} ${fmtIst(new Date().toISOString())}: ${note}`].filter(Boolean).join('\n') : t.notes
  const closed = check(
    await db().from('tasks').update({ status, notes }).eq('id', id).select('*').single(),
  ) as Task
  let next: Task | null = null
  if (t.recur && t.due_at) {
    next = await addTask({
      title: t.title,
      venture: t.venture,
      owner: t.owner,
      kind: t.kind,
      due_at: nextDue(new Date(t.due_at), t.recur).toISOString(),
      recur: t.recur,
      prompt: t.prompt,
      cwd: t.cwd,
      source: t.source,
      auto: t.auto,
    })
    await db().from('tasks').update({ parent_id: t.parent_id ?? t.id }).eq('id', next.id)
  }
  return { closed, next }
}

export interface Agenda {
  overdue: Task[]
  today: Task[]
  upcoming: Task[]
  undated: Task[]
  approvals: Approval[]
  events: CalendarEvent[]
}

export const agenda = async (days = 1, now: Date = new Date()): Promise<Agenda> => {
  const start = startOfTodayIst(now)
  const endToday = new Date(start.getTime() + 24 * 3600 * 1000)
  const end = new Date(start.getTime() + Math.max(days, 1) * 24 * 3600 * 1000)
  const open = await listTasks({ limit: 300 })
  const approvals = check(
    await db().from('approvals').select('*').eq('status', 'pending').is('deleted_at', null).order('id'),
  ) as Approval[]
  const events = check(
    await db()
      .from('events')
      .select('*')
      .is('deleted_at', null)
      .gte('starts_at', start.toISOString())
      .lt('starts_at', end.toISOString())
      .order('starts_at'),
  ) as CalendarEvent[]
  const due = (t: Task): number => (t.due_at ? new Date(t.due_at).getTime() : Number.NaN)
  return {
    overdue: open.filter((t) => due(t) < start.getTime()),
    today: open.filter((t) => due(t) >= start.getTime() && due(t) < endToday.getTime()),
    upcoming: open.filter((t) => due(t) >= endToday.getTime() && due(t) < end.getTime()),
    undated: open.filter((t) => !t.due_at),
    approvals,
    events,
  }
}

const line = (t: Task): string => {
  const flags = [t.owner, t.venture, t.recur ? `↻ ${t.recur}` : '', t.auto ? 'auto' : '', t.status !== 'todo' ? t.status : '']
    .filter(Boolean)
    .join(' · ')
  return `#${t.id} ${t.title} (${fmtIst(t.due_at)}; ${flags})`
}

export const formatAgenda = (a: Agenda, opts: { undated?: boolean } = {}): string => {
  const out: string[] = []
  const section = (name: string, items: string[]): void => {
    if (items.length) out.push(`**${name}**`, ...items.map((s) => `- ${s}`), '')
  }
  section(`Overdue (${a.overdue.length})`, a.overdue.map(line))
  section(`Today (${a.today.length})`, a.today.map(line))
  section('Calendar', a.events.map((e) => `${fmtIst(e.starts_at)} ${e.title}${e.location ? ` @ ${e.location}` : ''}`))
  section(`Coming up (${a.upcoming.length})`, a.upcoming.map(line))
  section(
    `Waiting for your yes (${a.approvals.length})`,
    a.approvals.map((p) => `approval #${p.id} [${p.channel}${p.recipient ? ` to ${p.recipient}` : ''}] ${p.draft.slice(0, 90)}`),
  )
  if (opts.undated) section(`No date (${a.undated.length})`, a.undated.map(line))
  return out.length ? out.join('\n').trim() : 'Nothing open.'
}

export const requestApproval = async (input: {
  task_id?: number
  channel: string
  recipient?: string
  draft: string
}): Promise<Approval> => {
  const ap = check(await db().from('approvals').insert(input).select('*').single()) as Approval
  if (input.task_id) await db().from('tasks').update({ status: 'waiting_approval' }).eq('id', input.task_id)
  // The decision card (✅/❌) goes to the bot DM via aos-watch; the channel only logs that a draft is queued.
  await notify(`ℹ️ Approval #${ap.id} queued · ${ap.channel}${ap.recipient ? ` → ${ap.recipient}` : ''} · decide in the bot DM`)
  return ap
}

export const listApprovals = async (status: Approval['status'] = 'pending'): Promise<Approval[]> =>
  check(
    await db().from('approvals').select('*').eq('status', status).is('deleted_at', null).order('id'),
  ) as Approval[]

// Approving queues an auto task for Claude to send exactly the approved text.
export const decideApproval = async (
  id: number,
  decision: 'approved' | 'rejected',
  editedDraft?: string,
): Promise<{ approval: Approval; sendTask: Task | null }> => {
  const patch: Partial<Approval> = { status: decision, decided_at: new Date().toISOString() }
  if (editedDraft) patch.draft = editedDraft
  const approval = check(
    await db().from('approvals').update(patch).eq('id', id).eq('status', 'pending').select('*').single(),
  ) as Approval
  let sendTask: Task | null = null
  if (decision === 'approved') {
    const parent = approval.task_id ? await getTask(approval.task_id) : null
    sendTask = await addTask({
      title: `SEND APPROVED #${approval.id} (${approval.channel}${approval.recipient ? ` to ${approval.recipient}` : ''})`,
      venture: parent?.venture ?? 'general',
      owner: 'claude',
      kind: 'send',
      due_at: new Date().toISOString(),
      auto: true,
      cwd: parent?.cwd ?? null,
      prompt:
        `Approval #${approval.id} was approved by Ayush. Send exactly this text, unchanged, ` +
        `via ${approval.channel}${approval.recipient ? ` to ${approval.recipient}` : ''}:\n\n${approval.draft}\n\n` +
        `Confirm it went out (check the sent view), then call approval_mark_sent with id ${approval.id} ` +
        `and log_activity. If it can't be sent, call approval_mark_sent with failed=true and the reason.`,
    })
  } else if (approval.task_id) {
    await db().from('tasks').update({ status: 'todo' }).eq('id', approval.task_id).eq('status', 'waiting_approval')
  }
  return { approval, sendTask }
}

export const markApprovalSent = async (id: number, result: string, failed = false): Promise<Approval> => {
  const ap = check(
    await db()
      .from('approvals')
      .update({ status: failed ? 'failed' : 'sent', result })
      .eq('id', id)
      .select('*')
      .single(),
  ) as Approval
  if (!failed) {
    // the send already happened; a counter hiccup must not turn it into an error
    await recordTouch(ap).catch(() => undefined)
  }
  if (!failed && ap.task_id) {
    const { count, error } = await db()
      .from('approvals')
      .select('id', { count: 'exact', head: true })
      .eq('task_id', ap.task_id)
      .in('status', ['pending', 'approved'])
    // an error is not "zero left": leave the parent open rather than close it early
    if (!error && count === 0) {
      const t = await getTask(ap.task_id)
      if (t.status === 'waiting_approval') await closeTask(ap.task_id, 'done', 'all approved drafts sent')
    }
  }
  return ap
}

export const logActivity = async (input: {
  venture: string
  channel: string
  account: string
  action: string
  result?: string
  task_id?: number
}): Promise<{ id: number }> =>
  check(await db().from('activity').insert(input).select('id').single()) as { id: number }

export const recentActivity = async (venture?: string, days = 7): Promise<{ at: string; venture: string; channel: string; account: string; action: string; result: string | null }[]> => {
  let q = db()
    .from('activity')
    .select('at, venture, channel, account, action, result')
    .gte('at', new Date(Date.now() - days * 24 * 3600 * 1000).toISOString())
    .order('at', { ascending: false })
    .limit(200)
  if (venture) q = q.eq('venture', venture)
  return check(await q) as { at: string; venture: string; channel: string; account: string; action: string; result: string | null }[]
}

export const addEvent = async (e: Omit<CalendarEvent, 'id'>): Promise<CalendarEvent> =>
  check(await db().from('events').insert(e).select('*').single()) as CalendarEvent
