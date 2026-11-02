'use client'

import { useEffect, useMemo, useState } from 'react'
import type { TaskRow } from '../../../lib/dash'
import { whenBucket, type WhenBucket } from '../../../lib/time'
import { ventureMeta } from '../../../lib/ventures'
import { VentureDot } from './bits'
import type { State, TaskFilters, When, Who } from './filters'
import { TaskItem } from './rows'

const WHEN: { key: When; label: string }[] = [
  { key: 'open', label: 'All open' },
  { key: 'late', label: 'Late' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Next 7 days' },
  { key: 'nodate', label: 'No date' },
  { key: 'closed', label: 'Done (14 days)' },
]
const WHO: { key: Who; label: string }[] = [
  { key: 'all', label: 'Everyone' },
  { key: 'me', label: 'Me' },
  { key: 'aos', label: 'aos' },
  { key: 'team', label: 'Team' },
]
const STATE: { key: State; label: string }[] = [
  { key: 'any', label: 'Any state' },
  { key: 'todo', label: 'To do' },
  { key: 'doing', label: 'In progress' },
  { key: 'waiting_approval', label: 'Needs your yes' },
]

const GROUPS: { key: WhenBucket | 'closed'; label: string }[] = [
  { key: 'overdue', label: 'Late' },
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'week', label: 'This week' },
  { key: 'later', label: 'Later' },
  { key: 'none', label: 'No date' },
  { key: 'closed', label: 'Done or skipped' },
]

const isOpen = (t: TaskRow): boolean => t.status !== 'done' && t.status !== 'skipped'

const matches = (t: TaskRow, f: TaskFilters, now: string): boolean => {
  const b = whenBucket(t.due_at, now)
  if (f.when === 'closed') {
    if (isOpen(t)) return false
  } else {
    if (!isOpen(t)) return false
    if (f.when === 'late' && b !== 'overdue') return false
    if (f.when === 'today' && b !== 'today') return false
    if (f.when === 'week' && !(b === 'today' || b === 'tomorrow' || b === 'week')) return false
    if (f.when === 'nodate' && b !== 'none') return false
    if (f.state !== 'any' && t.status !== f.state) return false
  }
  if (f.who === 'me' && t.owner !== 'ayush') return false
  if (f.who === 'aos' && t.owner !== 'claude') return false
  if (f.who === 'team' && (t.owner === 'ayush' || t.owner === 'claude')) return false
  if (f.venture && t.venture !== f.venture) return false
  if (f.q) {
    const q = f.q.toLowerCase()
    if (!t.title.toLowerCase().includes(q) && !(t.notes ?? '').toLowerCase().includes(q) && String(t.id) !== q.replace('#', '')) return false
  }
  return true
}

const Chip = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={on}
    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors ${
      on ? 'border-ink bg-ink text-ground' : 'border-line text-dim active:bg-raised'
    }`}
  >
    {children}
  </button>
)

const Row = ({ children, label }: { children: React.ReactNode; label: string }) => (
  <div role="group" aria-label={label} className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 py-1">
    {children}
  </div>
)

// All filtering happens here in the browser: changing a filter costs no server render.
export const TaskBrowser = ({
  tasks,
  now,
  initial,
  lockVenture,
}: {
  tasks: TaskRow[]
  now: string
  initial: TaskFilters
  lockVenture?: boolean
}) => {
  const [f, setF] = useState<TaskFilters>(initial)
  const set = (patch: Partial<TaskFilters>): void => setF((prev) => ({ ...prev, ...patch }))

  // Keep the URL in step so a filtered view can be bookmarked; replaceState makes no request.
  useEffect(() => {
    const p = new URLSearchParams()
    if (f.when !== 'open') p.set('when', f.when)
    if (f.who !== 'all') p.set('who', f.who)
    if (f.state !== 'any') p.set('state', f.state)
    if (f.venture && !lockVenture) p.set('v', f.venture)
    if (f.q) p.set('q', f.q)
    const qs = p.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`)
  }, [f, lockVenture])

  const ventures = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of tasks) if (isOpen(t)) counts.set(t.venture, (counts.get(t.venture) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [tasks])

  const shown = useMemo(() => tasks.filter((t) => matches(t, f, now)), [tasks, f, now])
  const groups = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        items: shown
          .filter((t) => (g.key === 'closed' ? !isOpen(t) : isOpen(t) && whenBucket(t.due_at, now) === g.key))
          .sort((a, b) => (g.key === 'closed' ? b.updated_at.localeCompare(a.updated_at) : (a.due_at ?? '').localeCompare(b.due_at ?? ''))),
      })).filter((g) => g.items.length > 0),
    [shown, now],
  )
  const filtered = f.when !== 'open' || f.who !== 'all' || f.state !== 'any' || (!lockVenture && f.venture) || f.q

  return (
    <div>
      <div className="sticky top-0 z-20 -mx-4 border-b border-line bg-ground/95 px-4 pt-3 pb-2 backdrop-blur md:top-12">
        <label className="sr-only" htmlFor="task-q">
          Search tasks
        </label>
        <input
          id="task-q"
          type="search"
          value={f.q}
          onChange={(e) => set({ q: e.target.value })}
          placeholder="Search titles, notes or #id"
          className="w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-[15px] placeholder:text-faint focus:border-dim focus:outline-none"
        />
        <div className="mt-2 space-y-1">
          <Row label="When">
            {WHEN.map((w) => (
              <Chip key={w.key} on={f.when === w.key} onClick={() => set({ when: w.key })}>
                {w.label}
              </Chip>
            ))}
          </Row>
          <Row label="Who">
            {WHO.map((w) => (
              <Chip key={w.key} on={f.who === w.key} onClick={() => set({ who: w.key })}>
                {w.label}
              </Chip>
            ))}
            {f.when !== 'closed' ? (
              <>
                <span aria-hidden="true" className="mx-1 w-px shrink-0 bg-line" />
                {STATE.map((s) => (
                  <Chip key={s.key} on={f.state === s.key} onClick={() => set({ state: s.key })}>
                    {s.label}
                  </Chip>
                ))}
              </>
            ) : null}
          </Row>
          {!lockVenture ? (
            <Row label="Venture">
              <Chip on={f.venture === ''} onClick={() => set({ venture: '' })}>
                All ventures
              </Chip>
              {ventures.map(([v, n]) => (
                <Chip key={v} on={f.venture === v} onClick={() => set({ venture: f.venture === v ? '' : v })}>
                  <VentureDot venture={v} />
                  {ventureMeta(v).name}
                  <span className="opacity-60 tabular-nums">{n}</span>
                </Chip>
              ))}
            </Row>
          ) : null}
        </div>
      </div>

      <p className="mt-3 flex items-center justify-between text-sm text-faint" aria-live="polite">
        <span>
          {shown.length} {shown.length === 1 ? 'task' : 'tasks'}
        </span>
        {filtered ? (
          <button
            type="button"
            className="text-dim underline underline-offset-2"
            onClick={() => setF({ when: 'open', who: 'all', state: 'any', venture: lockVenture ? initial.venture : '', q: '' })}
          >
            Clear filters
          </button>
        ) : null}
      </p>

      {groups.length === 0 ? (
        <p className="py-10 text-center text-sm text-faint">No tasks match. Try another filter or clear them.</p>
      ) : (
        groups.map((g) => (
          <section key={g.key} className="mt-5">
            <h2 className={`text-sm font-semibold ${g.key === 'overdue' ? 'text-late' : 'text-dim'}`}>
              {g.label} <span className="font-normal text-faint tabular-nums">{g.items.length}</span>
            </h2>
            <ul className="divide-y divide-line">
              {g.items.map((t) => (
                <TaskItem key={t.id} t={t} now={now} showVenture={!lockVenture} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}
