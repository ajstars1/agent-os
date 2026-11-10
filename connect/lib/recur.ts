import { addDays, weekdayCode } from './time'

export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

// Same grammar as the database check on tasks.recur.
export const isValidRecur = (recur: string): boolean =>
  recur === 'daily' ||
  recur === 'weekdays' ||
  /^every:[0-9]{1,3}d$/.test(recur) ||
  /^weekly:(SU|MO|TU|WE|TH|FR|SA)(,(SU|MO|TU|WE|TH|FR|SA)){0,6}$/.test(recur)

const step = (from: Date, recur: string, tz: string): Date => {
  if (recur === 'daily') return addDays(from, 1, tz)
  if (recur.startsWith('every:')) return addDays(from, Math.max(1, Number(recur.slice(6, -1))), tz)
  const allowed: readonly string[] = recur === 'weekdays' ? ['MO', 'TU', 'WE', 'TH', 'FR'] : recur.slice(7).split(',')
  let next = addDays(from, 1, tz)
  for (let i = 0; i < 7 && !allowed.includes(weekdayCode(next, tz)); i++) next = addDays(next, 1, tz)
  return next
}

// Next occurrence strictly after now, at the same wall-clock time in the user's zone, so a task finished late
// does not fire again at once.
export const nextDue = (due: Date, recur: string, tz: string, now: Date = new Date()): Date => {
  if (!isValidRecur(recur)) throw new Error(`Invalid recur: ${recur}`)
  let next = step(due, recur, tz)
  for (let i = 0; i < 4000 && next.getTime() <= now.getTime(); i++) next = step(next, recur, tz)
  return next
}
