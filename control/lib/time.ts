// IST date helpers that work on the server and in client components (no Node APIs).
const IST = 'Asia/Kolkata'
const DAY = 24 * 3600 * 1000

export const istYmd = (d: Date): string => d.toLocaleDateString('en-CA', { timeZone: IST })

export const istDayStart = (d: Date): number => new Date(`${istYmd(d)}T00:00:00+05:30`).getTime()

export const fmtTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit' })

export const fmtDay = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short' })

export const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { timeZone: IST, day: 'numeric', month: 'short' })

// "Today 4 pm", "Tomorrow 10 am", "Wed 4 Nov, 9 am"
export const fmtDue = (iso: string | null, nowIso: string): string => {
  if (!iso) return 'No date'
  const start = istDayStart(new Date(nowIso))
  const t = new Date(iso).getTime()
  const time = fmtTime(iso)
  if (t >= start && t < start + DAY) return `Today ${time}`
  if (t >= start + DAY && t < start + 2 * DAY) return `Tomorrow ${time}`
  if (t >= start - DAY && t < start) return `Yesterday ${time}`
  return `${fmtDay(iso)}, ${time}`
}

export const ago = (iso: string | null, nowIso: string): string => {
  if (!iso) return 'never'
  const s = Math.max(0, (new Date(nowIso).getTime() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

// Whole days late, counted in IST calendar days.
export const daysLate = (iso: string, nowIso: string): number =>
  Math.max(0, Math.round((istDayStart(new Date(nowIso)) - istDayStart(new Date(iso))) / DAY))

export type WhenBucket = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'none'

export const whenBucket = (iso: string | null, nowIso: string): WhenBucket => {
  if (!iso) return 'none'
  const start = istDayStart(new Date(nowIso))
  const t = new Date(iso).getTime()
  if (t < start) return 'overdue'
  if (t < start + DAY) return 'today'
  if (t < start + 2 * DAY) return 'tomorrow'
  if (t < start + 7 * DAY) return 'week'
  return 'later'
}
