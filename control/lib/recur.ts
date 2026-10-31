const DAY_MS = 24 * 60 * 60 * 1000
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

// India has no DST, so adding whole days keeps the IST time of day.
export const istWeekday = (d: Date): string => {
  const name = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'Asia/Kolkata' })
  return name.slice(0, 2).toUpperCase()
}

export const isValidRecur = (recur: string): boolean =>
  recur === 'daily' ||
  recur === 'weekdays' ||
  /^every:\d+d$/.test(recur) ||
  /^weekly:(SU|MO|TU|WE|TH|FR|SA)(,(SU|MO|TU|WE|TH|FR|SA))*$/.test(recur)

const step = (from: Date, recur: string): Date => {
  if (recur === 'daily') return new Date(from.getTime() + DAY_MS)
  if (recur.startsWith('every:')) {
    const n = Number(recur.slice(6, -1))
    return new Date(from.getTime() + n * DAY_MS)
  }
  const allowed: readonly string[] =
    recur === 'weekdays' ? ['MO', 'TU', 'WE', 'TH', 'FR'] : recur.slice(7).split(',')
  let next = new Date(from.getTime() + DAY_MS)
  for (let i = 0; i < 7 && !allowed.includes(istWeekday(next)); i++) {
    next = new Date(next.getTime() + DAY_MS)
  }
  return next
}

// Next occurrence strictly after now, so a task finished late doesn't fire again at once.
export const nextDue = (due: Date, recur: string, now: Date = new Date()): Date => {
  if (!isValidRecur(recur)) throw new Error(`Invalid recur: ${recur}`)
  let next = step(due, recur)
  while (next.getTime() <= now.getTime()) next = step(next, recur)
  return next
}

export { WEEKDAYS }
