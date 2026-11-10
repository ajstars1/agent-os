// Time-zone maths without a library. Users are anywhere, so "today" and "same time tomorrow" are always computed
// in the user's own zone, including across daylight-saving changes.

export const DEFAULT_TZ = 'Asia/Kolkata'
export const DAY_MS = 24 * 60 * 60 * 1000

export const isValidTimeZone = (tz: string): boolean => {
  if (!tz || tz.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export interface Wall {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
  second: number
}

// The clock-on-the-wall reading of an instant in a zone.
export const wallTime = (d: Date, tz: string): Wall => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d)
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') }
}

const offsetMs = (d: Date, tz: string): number => {
  const w = wallTime(d, tz)
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(d.getTime() / 1000) * 1000
}

// The instant at which a zone's wall clock shows the given reading. Day overflow is fine (day 32 rolls over).
// A reading skipped by a daylight-saving jump lands just after the jump.
export const instantOf = (w: Wall, tz: string): Date => {
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  const first = asUtc - offsetMs(new Date(asUtc), tz)
  return new Date(asUtc - offsetMs(new Date(first), tz))
}

export const dayStart = (d: Date, tz: string): Date => {
  const w = wallTime(d, tz)
  return instantOf({ ...w, hour: 0, minute: 0, second: 0 }, tz)
}

// Same wall-clock time, n days later.
export const addDays = (d: Date, n: number, tz: string): Date => {
  const w = wallTime(d, tz)
  return instantOf({ ...w, day: w.day + n }, tz)
}

export const weekdayCode = (d: Date, tz: string): string =>
  d.toLocaleDateString('en-US', { weekday: 'short', timeZone: tz }).slice(0, 2).toUpperCase()

export const fmtWhen = (iso: string | null, tz: string): string => {
  if (!iso) return 'no date'
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

export const fmtDay = (iso: string, tz: string): string =>
  new Date(iso).toLocaleDateString('en-GB', { timeZone: tz, day: 'numeric', month: 'short' })
