// All data access. Every function takes the caller's own Supabase client, so row level security scopes it.
// Multi-table writes go through database functions (one transaction each); see the migration.
import type { SupabaseClient } from '@supabase/supabase-js'
import { agendaWindow, buildAgenda, type Agenda } from './agenda'
import { isValidRecur, nextDue } from './recur'
import { DAY_MS, DEFAULT_TZ, isValidTimeZone } from './time'
import {
  ACTIVITY_COLS,
  APPROVAL_COLS,
  EVENT_COLS,
  GOAL_COLS,
  TASK_COLS,
  type ActivityRow,
  type Approval,
  type ApprovalStatus,
  type CalendarEvent,
  type Goal,
  type Owner,
  type Task,
  type TaskStatus,
} from './types'

const OPEN: TaskStatus[] = ['todo', 'doing', 'waiting_approval']

interface Result<T> {
  data: T | null
  error: { message: string } | null
}

const check = <T>(res: Result<T>): T => {
  if (res.error) throw new Error(res.error.message)
  if (res.data === null) throw new Error('Not found')
  return res.data
}

// A database function that returns one row gives it back as an object, or as a one-element list.
const one = <T>(res: Result<T | T[]>): T => {
  const data = check(res)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('Not found')
  return row
}

// ---- profile ----------------------------------------------------------------------------------------------

export const getTimeZone = async (sb: SupabaseClient): Promise<string> => {
  const { data, error } = await sb.from('profiles').select('timezone').is('deleted_at', null).maybeSingle()
  if (error) throw new Error(error.message)
  const tz = (data as { timezone: string } | null)?.timezone
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_TZ
}

export const setProfile = async (
  sb: SupabaseClient,
  patch: { timezone?: string; display_name?: string | null },
): Promise<{ timezone: string; display_name: string | null }> => {
  if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) {
    throw new Error(`Unknown time zone "${patch.timezone}". Use an IANA name such as Asia/Kolkata or America/New_York.`)
  }
  // user_id defaults to the caller in the database, so the upsert can only ever touch their own row
  const existing = await sb.from('profiles').select('user_id').maybeSingle()
  if (existing.error) throw new Error(existing.error.message)
  const q = existing.data
    ? sb.from('profiles').update(patch).eq('user_id', (existing.data as { user_id: string }).user_id)
    : sb.from('profiles').insert(patch)
  return check(await q.select('timezone,display_name').single()) as { timezone: string; display_name: string | null }
}

// ---- tasks ------------------------------------------------------------------------------------------------

export interface NewTask {
  title: string
  area?: string
  owner?: Owner
  due_at?: string | null
  recur?: string | null
  notes?: string | null
  goal_id?: number | null
}

export type TaskPatch = Partial<NewTask> & { status?: TaskStatus }

export interface TaskFilter {
  status?: TaskStatus[]
  owner?: Owner
  area?: string
  query?: string
  dueBefore?: string
  limit?: number
}

const validateTask = (t: Partial<NewTask>): void => {
  if (t.recur && !isValidRecur(t.recur)) throw new Error(`recur must be daily | weekdays | weekly:MO,TH | every:3d (got "${t.recur}")`)
  if (t.recur && !t.due_at) throw new Error('A repeating task needs a due time')
}

export const listTasks = async (sb: SupabaseClient, f: TaskFilter = {}): Promise<Task[]> => {
  let q = sb
    .from('tasks')
    .select(TASK_COLS)
    .is('deleted_at', null)
    .in('status', f.status ?? OPEN)
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(Math.min(f.limit ?? 100, 300))
  if (f.owner) q = q.eq('owner', f.owner)
  if (f.area) q = q.eq('area', f.area)
  if (f.dueBefore) q = q.lte('due_at', f.dueBefore)
  if (f.query) q = q.ilike('title', `%${f.query.replace(/[%_\\]/g, '')}%`)
  return check(await q) as unknown as Task[]
}

export const getTask = async (sb: SupabaseClient, id: number): Promise<Task> =>
  check(await sb.from('tasks').select(TASK_COLS).eq('id', id).is('deleted_at', null).maybeSingle()) as unknown as Task

export const addTask = async (sb: SupabaseClient, t: NewTask): Promise<Task> => {
  validateTask(t)
  return check(await sb.from('tasks').insert(t).select(TASK_COLS).single()) as unknown as Task
}

export const updateTask = async (sb: SupabaseClient, id: number, patch: TaskPatch): Promise<Task> => {
  if (patch.status === 'done' || patch.status === 'skipped') {
    throw new Error('Use task_done to finish a task, so a repeating task gets its next occurrence')
  }
  const current = await getTask(sb, id)
  validateTask({ ...current, ...patch })
  return check(
    await sb.from('tasks').update(patch).eq('id', id).is('deleted_at', null).select(TASK_COLS).maybeSingle(),
  ) as unknown as Task
}

// Soft delete only.
export const deleteTask = async (sb: SupabaseClient, id: number): Promise<{ id: number }> =>
  check(
    await sb.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', id).is('deleted_at', null).select('id').maybeSingle(),
  ) as { id: number }

export const completeTask = async (
  sb: SupabaseClient,
  id: number,
  status: 'done' | 'skipped',
  note?: string,
  now: Date = new Date(),
): Promise<{ closed: Task; next: Task | null }> => {
  const t = await getTask(sb, id)
  const next = t.recur && t.due_at ? nextDue(new Date(t.due_at), t.recur, await getTimeZone(sb), now).toISOString() : null
  const rows = check(
    await sb.rpc('complete_task', { p_id: id, p_status: status, p_note: note ?? null, p_next_due: next }),
  ) as Task[]
  if (!rows[0]) throw new Error('Not found')
  return { closed: rows[0], next: rows[1] ?? null }
}

// ---- approvals --------------------------------------------------------------------------------------------

export const requestApproval = async (
  sb: SupabaseClient,
  input: { channel: string; draft: string; recipient?: string; subject?: string; task_id?: number; send_after?: string },
): Promise<Approval> =>
  one<Approval>(
    await sb.rpc('request_approval', {
      p_channel: input.channel,
      p_draft: input.draft,
      p_recipient: input.recipient ?? null,
      p_task_id: input.task_id ?? null,
      p_send_after: input.send_after ?? null,
      p_subject: input.subject ?? null,
    }),
  )

export const listApprovals = async (sb: SupabaseClient, status: ApprovalStatus = 'pending'): Promise<Approval[]> =>
  check(
    await sb.from('approvals').select(APPROVAL_COLS).eq('status', status).is('deleted_at', null).order('id').limit(200),
  ) as unknown as Approval[]

// Works only with the person's own sign-in. The database refuses it for a connected app's token.
export const decideApproval = async (
  sb: SupabaseClient,
  id: number,
  decision: 'approved' | 'rejected',
  editedDraft?: string,
): Promise<Approval> =>
  one<Approval>(await sb.rpc('decide_approval', { p_id: id, p_decision: decision, p_edited_draft: editedDraft ?? null }))

export const markApprovalSent = async (sb: SupabaseClient, id: number, result: string, failed = false): Promise<Approval> =>
  one<Approval>(await sb.rpc('mark_approval_sent', { p_id: id, p_result: result, p_failed: failed }))

// ---- activity ---------------------------------------------------------------------------------------------

export const logActivity = async (
  sb: SupabaseClient,
  input: { area?: string; channel: string; account: string; action: string; result?: string; task_id?: number },
): Promise<{ id: number }> => check(await sb.from('activity').insert(input).select('id').single()) as { id: number }

export const recentActivity = async (sb: SupabaseClient, area?: string, days = 7, now: Date = new Date()): Promise<ActivityRow[]> => {
  let q = sb
    .from('activity')
    .select(ACTIVITY_COLS)
    .is('deleted_at', null)
    .gte('at', new Date(now.getTime() - Math.min(days, 90) * DAY_MS).toISOString())
    .order('at', { ascending: false })
    .limit(200)
  if (area) q = q.eq('area', area)
  return check(await q) as unknown as ActivityRow[]
}

// ---- goals ------------------------------------------------------------------------------------------------

export const addGoal = async (
  sb: SupabaseClient,
  g: { title: string; target: number; area?: string; unit?: string; due_at?: string | null; current?: number },
): Promise<Goal> => check(await sb.from('goals').insert(g).select(GOAL_COLS).single()) as unknown as Goal

export const listGoals = async (sb: SupabaseClient, includeClosed = false): Promise<Goal[]> => {
  let q = sb.from('goals').select(GOAL_COLS).is('deleted_at', null).order('due_at', { ascending: true, nullsFirst: false }).limit(200)
  if (!includeClosed) q = q.eq('status', 'active')
  return check(await q) as unknown as Goal[]
}

export const recordGoalReading = async (sb: SupabaseClient, goalId: number, value: number, note?: string): Promise<Goal> =>
  one<Goal>(await sb.rpc('record_goal_reading', { p_goal_id: goalId, p_value: value, p_note: note ?? null }))

export const dropGoal = async (sb: SupabaseClient, id: number): Promise<Goal> =>
  check(
    await sb.from('goals').update({ status: 'dropped' }).eq('id', id).is('deleted_at', null).select(GOAL_COLS).maybeSingle(),
  ) as unknown as Goal

// ---- calendar ---------------------------------------------------------------------------------------------

export const addEvent = async (
  sb: SupabaseClient,
  e: { title: string; starts_at: string; area?: string; ends_at?: string | null; location?: string | null; notes?: string | null },
): Promise<CalendarEvent> => check(await sb.from('events').insert(e).select(EVENT_COLS).single()) as unknown as CalendarEvent

// ---- agenda -----------------------------------------------------------------------------------------------

export const loadAgenda = async (
  sb: SupabaseClient,
  days = 1,
  now: Date = new Date(),
): Promise<{ agenda: Agenda; tz: string }> => {
  const tz = await getTimeZone(sb)
  const w = agendaWindow(now, tz, days)
  const [tasks, approvals, goals, events] = await Promise.all([
    listTasks(sb, { limit: 300 }),
    listApprovals(sb, 'pending'),
    listGoals(sb),
    sb
      .from('events')
      .select(EVENT_COLS)
      .is('deleted_at', null)
      .gte('starts_at', w.start.toISOString())
      .lt('starts_at', w.end.toISOString())
      .order('starts_at')
      .limit(100),
  ])
  return { agenda: buildAgenda({ tasks, approvals, goals, events: check(events) as unknown as CalendarEvent[] }, w), tz }
}

// ---- phone channel ----------------------------------------------------------------------------------------

export interface PhoneLink {
  label: string | null
  created_at: string
}

export const phoneLink = async (sb: SupabaseClient): Promise<PhoneLink | null> => {
  const { data, error } = await sb.from('channel_links').select('label,created_at').eq('channel', 'telegram').is('deleted_at', null).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as PhoneLink | null) ?? null
}

// A one-time code for t.me/<bot>?start=<code>. The database refuses it for a connected app's token.
export const createLinkCode = async (sb: SupabaseClient): Promise<string> => {
  const { data, error } = await sb.rpc('create_link_code', { p_channel: 'telegram' })
  if (error) throw new Error(error.message)
  if (typeof data !== 'string' || !/^[0-9a-f]{64}$/.test(data)) throw new Error('No link code returned')
  return data
}

export const unlinkPhone = async (sb: SupabaseClient): Promise<void> => {
  const { error } = await sb.from('channel_links').update({ deleted_at: new Date().toISOString() }).eq('channel', 'telegram').is('deleted_at', null)
  if (error) throw new Error(error.message)
}

// ---- connections (the vault) --------------------------------------------------------------------------------

export interface MailConnection {
  provider: string
  username: string
  from_name: string | null
}

// The person's own view, on the site. A connected app's token gets nothing from this table.
export const mailConnection = async (sb: SupabaseClient): Promise<MailConnection | null> => {
  const { data, error } = await sb.from('secrets').select('meta').eq('kind', 'smtp').is('deleted_at', null).maybeSingle()
  if (error) throw new Error(error.message)
  const meta = (data as { meta: Record<string, unknown> } | null)?.meta
  if (!meta || typeof meta.provider !== 'string' || typeof meta.username !== 'string') return null
  return { provider: meta.provider, username: meta.username, from_name: typeof meta.from_name === 'string' ? meta.from_name : null }
}

// sealed = the login already encrypted by the server (lib/vault.ts). The database refuses this for a connected app.
export const saveMailConnection = async (sb: SupabaseClient, meta: MailConnection, sealed: string): Promise<void> => {
  const { error } = await sb.rpc('put_secret', { p_kind: 'smtp', p_meta: meta, p_ciphertext: sealed })
  if (error) throw new Error(error.message)
}

export const removeMailConnection = async (sb: SupabaseClient): Promise<void> => {
  const { error } = await sb.rpc('remove_secret', { p_kind: 'smtp' })
  if (error) throw new Error(error.message)
}

export interface ConnectionStatus {
  email: { connected: boolean; address_hint?: string }
  api_keys: { name: string; host: string; changes: string }[]
}

export interface ApiKeyInfo {
  name: string
  host: string
  scheme: string
  writes: string
}

// The person's own view of their saved keys: names and hosts, never the keys.
export const apiKeys = async (sb: SupabaseClient): Promise<ApiKeyInfo[]> => {
  const { data, error } = await sb.from('secrets').select('name,meta').eq('kind', 'api').is('deleted_at', null).order('name')
  if (error) throw new Error(error.message)
  return ((data ?? []) as { name: string; meta: Record<string, unknown> }[]).map((r) => ({
    name: r.name,
    host: String(r.meta.host ?? ''),
    scheme: String(r.meta.scheme ?? ''),
    writes: String(r.meta.writes ?? 'never'),
  }))
}

export const saveApiKey = async (
  sb: SupabaseClient,
  name: string,
  meta: { host: string; scheme: string; header?: string; writes: 'never' | 'ask' },
  sealed: string,
): Promise<void> => {
  const { error } = await sb.rpc('put_secret', { p_kind: 'api', p_meta: meta, p_ciphertext: sealed, p_name: name })
  if (error) throw new Error(error.message)
}

export const removeApiKey = async (sb: SupabaseClient, name: string): Promise<void> => {
  const { error } = await sb.rpc('remove_secret', { p_kind: 'api', p_name: name })
  if (error) throw new Error(error.message)
}

// Ask for a request that changes something. It waits for the person's yes; aos then makes it with the saved key.
export const requestAction = async (
  sb: SupabaseClient,
  input: { key: string; method: string; path: string; body?: string | null; content_type?: string },
): Promise<Approval> =>
  one<Approval>(
    await sb.rpc('request_action', {
      p_key: input.key,
      p_method: input.method,
      p_path: input.path,
      p_body: input.body ?? null,
      p_content_type: input.content_type ?? null,
    }),
  )

export type MaskLevel = 'off' | 'api' | 'all'

export const getMaskLevel = async (sb: SupabaseClient): Promise<MaskLevel> => {
  const { data, error } = await sb.from('profiles').select('mask_level').is('deleted_at', null).maybeSingle()
  if (error) throw new Error(error.message)
  const level = (data as { mask_level: string } | null)?.mask_level
  return level === 'off' || level === 'all' ? level : 'api'
}

// The database refuses this for a connected app.
export const setMaskLevel = async (sb: SupabaseClient, level: MaskLevel): Promise<void> => {
  const existing = await sb.from('profiles').select('user_id').maybeSingle()
  if (existing.error) throw new Error(existing.error.message)
  const q = existing.data
    ? sb.from('profiles').update({ mask_level: level }).eq('user_id', (existing.data as { user_id: string }).user_id)
    : sb.from('profiles').insert({ mask_level: level })
  const { error } = await q
  if (error) throw new Error(error.message)
}

// What a stand-in such as [EMAIL_12] stands for. Only the person, on the site.
export const lookupHandle = async (sb: SupabaseClient, kind: 'email' | 'phone', n: number): Promise<string | null> => {
  const { data, error } = await sb.from('handles').select('value').eq('kind', kind).eq('n', n).is('deleted_at', null).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as { value: string } | null)?.value ?? null
}

// What an assistant may know about the person's connections: that one exists, and a hint of the address.
export const connectionStatus = async (sb: SupabaseClient): Promise<ConnectionStatus> => {
  const { data, error } = await sb.rpc('connection_status', {})
  if (error) throw new Error(error.message)
  return data as ConnectionStatus
}

// ---- rate limit -------------------------------------------------------------------------------------------

// Counts one request for the caller. False means over the limit for this window.
export const withinRate = async (sb: SupabaseClient, bucket: string, limit: number, windowS: number): Promise<boolean> => {
  const { data, error } = await sb.rpc('hit_rate', { p_bucket: bucket, p_limit: limit, p_window_s: windowS })
  if (error) throw new Error(error.message)
  return data === true
}
