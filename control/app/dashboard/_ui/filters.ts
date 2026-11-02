// Task filter shape and URL parsing; plain module so server pages can call it.

export type When = 'open' | 'late' | 'today' | 'week' | 'nodate' | 'closed'
export type Who = 'all' | 'me' | 'aos' | 'team'
export type State = 'any' | 'todo' | 'doing' | 'waiting_approval'

export interface TaskFilters {
  when: When
  who: Who
  state: State
  venture: string
  q: string
}

const pick = <T extends string>(v: string | undefined, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback

export const parseFilters = (sp: Record<string, string | string[] | undefined>, venture = ''): TaskFilters => {
  const s = (k: string): string | undefined => {
    const v = sp[k]
    return typeof v === 'string' ? v : undefined
  }
  return {
    when: pick(s('when'), ['open', 'late', 'today', 'week', 'nodate', 'closed'] as const, 'open'),
    who: pick(s('who'), ['all', 'me', 'aos', 'team'] as const, 'all'),
    state: pick(s('state'), ['any', 'todo', 'doing', 'waiting_approval'] as const, 'any'),
    venture: venture || (s('v') ?? '').slice(0, 40),
    q: (s('q') ?? '').slice(0, 100),
  }
}
