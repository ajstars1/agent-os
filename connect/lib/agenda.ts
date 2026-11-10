// Pure agenda logic: no database, no clock of its own. Everything is computed in the user's time zone.
import { DAY_MS, addDays, dayStart, fmtDay, fmtWhen } from './time'
import type { Approval, CalendarEvent, Goal, Task } from './types'

export interface Agenda {
  overdue: Task[]
  today: Task[]
  upcoming: Task[]
  undated: Task[]
  approvals: Approval[]
  events: CalendarEvent[]
  goals: Goal[]
}

export interface AgendaWindow {
  start: Date // start of today in the user's zone
  endToday: Date
  end: Date // end of the window (start + days)
}

export const agendaWindow = (now: Date, tz: string, days = 1): AgendaWindow => {
  const start = dayStart(now, tz)
  return { start, endToday: addDays(start, 1, tz), end: addDays(start, Math.max(1, days), tz) }
}

export const buildAgenda = (
  input: { tasks: Task[]; approvals: Approval[]; events: CalendarEvent[]; goals: Goal[] },
  w: AgendaWindow,
): Agenda => {
  const due = (t: Task): number => (t.due_at ? new Date(t.due_at).getTime() : Number.NaN)
  const [s, e1, e] = [w.start.getTime(), w.endToday.getTime(), w.end.getTime()]
  return {
    overdue: input.tasks.filter((t) => due(t) < s),
    today: input.tasks.filter((t) => due(t) >= s && due(t) < e1),
    upcoming: input.tasks.filter((t) => due(t) >= e1 && due(t) < e),
    undated: input.tasks.filter((t) => !t.due_at),
    approvals: input.approvals,
    events: input.events,
    goals: input.goals.filter((g) => g.status === 'active'),
  }
}

export type Pace = 'met' | 'on pace' | 'behind' | 'late' | 'no date'

// Straight-line pace: by now, the goal should be this far along between its start and its due date.
export const goalPace = (g: Goal, now: Date): { pace: Pace; expected: number } => {
  if (g.current >= g.target) return { pace: 'met', expected: g.target }
  if (!g.due_at) return { pace: 'no date', expected: 0 }
  const start = new Date(g.created_at).getTime()
  const end = new Date(g.due_at).getTime()
  if (now.getTime() >= end) return { pace: 'late', expected: g.target }
  const span = Math.max(end - start, DAY_MS)
  const fraction = Math.min(1, Math.max(0, (now.getTime() - start) / span))
  const expected = g.target * fraction
  // a quarter of a step of slack, so one missed day on a long goal is not "behind"
  return { pace: g.current + 0.25 >= expected ? 'on pace' : 'behind', expected: Math.round(expected * 10) / 10 }
}

const num = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1))

export const goalLine = (g: Goal, now: Date, tz: string): string => {
  const { pace, expected } = goalPace(g, now)
  const unit = g.unit ? ` ${g.unit}` : ''
  const due = g.due_at ? `, due ${fmtDay(g.due_at, tz)}` : ''
  const note =
    pace === 'behind' ? ` (behind: about ${num(expected)} expected by now)` : pace === 'late' ? ' (past its date)' : pace === 'on pace' ? ' (on pace)' : ''
  return `goal #${g.id} ${g.title}: ${num(g.current)} of ${num(g.target)}${unit}${due}${note}`
}

const taskLine = (t: Task, tz: string): string => {
  const flags = [t.owner === 'assistant' ? 'assistant' : 'you', t.area, t.recur ? `repeats ${t.recur}` : '', t.status !== 'todo' ? t.status : '']
    .filter(Boolean)
    .join(' · ')
  return `#${t.id} ${t.title} (${fmtWhen(t.due_at, tz)}; ${flags})`
}

export const formatAgenda = (a: Agenda, now: Date, tz: string, opts: { undated?: boolean } = {}): string => {
  const out: string[] = []
  const section = (name: string, items: string[]): void => {
    if (items.length) out.push(`**${name}**`, ...items.map((s) => `- ${s}`), '')
  }
  section(`Overdue (${a.overdue.length})`, a.overdue.map((t) => taskLine(t, tz)))
  section(`Today (${a.today.length})`, a.today.map((t) => taskLine(t, tz)))
  section(
    'Calendar',
    a.events.map((e) => `${fmtWhen(e.starts_at, tz)} ${e.title}${e.location ? ` @ ${e.location}` : ''}`),
  )
  section(`Coming up (${a.upcoming.length})`, a.upcoming.map((t) => taskLine(t, tz)))
  section(
    `Drafts waiting for the person's yes (${a.approvals.length})`,
    a.approvals.map((p) => `approval #${p.id} [${p.channel}${p.recipient ? ` to ${p.recipient}` : ''}] ${p.draft.slice(0, 90)}`),
  )
  section('Goals', a.goals.map((g) => goalLine(g, now, tz)))
  if (opts.undated) section(`No date (${a.undated.length})`, a.undated.map((t) => taskLine(t, tz)))
  return out.length ? out.join('\n').trim() : 'Nothing open.'
}
