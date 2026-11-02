// Row renderers used on several pages (server) and inside the client-side browsers.
import type { ActivityRow, ApprovalRow, GoalRow, RunRow, TaskRow } from '../../../lib/dash'
import { ago, daysLate, fmtDate, fmtDue, fmtDay, fmtTime, whenBucket } from '../../../lib/time'
import { ventureMeta } from '../../../lib/ventures'
import { StateMark, VentureDot, VentureTag, money, ownerName, taskMark } from './bits'
import { DraftDecision } from './draft-decision'

export const TaskItem = ({ t, now, showVenture = true }: { t: TaskRow; now: string; showVenture?: boolean }) => {
  const open = t.status !== 'done' && t.status !== 'skipped'
  const late = open && whenBucket(t.due_at, now) === 'overdue'
  const mark = taskMark(t.status)
  return (
    <li>
      <details className="group">
        <summary className="flex cursor-pointer list-none gap-3 py-3">
          {showVenture ? <span className="mt-1.5"><VentureDot venture={t.venture} /></span> : null}
          <div className="min-w-0 flex-1">
            <p className={`text-[15px] leading-snug break-words ${open ? '' : 'text-dim line-through decoration-faint'}`}>{t.title}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim">
              {late && t.due_at ? (
                <StateMark mark="late" text={`${daysLate(t.due_at, now) || 'today'}${daysLate(t.due_at, now) ? 'd late' : ''}`} />
              ) : null}
              {mark ? <StateMark mark={mark} /> : null}
              <span>{open ? fmtDue(t.due_at, now) : `closed ${ago(t.updated_at, now)}`}</span>
              <span className="text-faint">{ownerName(t.owner)}</span>
              {t.recur ? <span className="text-faint">repeats {t.recur.replace('weekly:', 'weekly ')}</span> : null}
            </p>
          </div>
        </summary>
        <div className="mb-3 ml-5 rounded-lg bg-raised px-3 py-2.5 text-sm text-dim">
          <p>
            #{t.id} · {ventureMeta(t.venture).name} · {t.kind}
            {t.auto ? ' · aos runs it by itself' : ''}
          </p>
          {t.notes ? <p className="mt-2 whitespace-pre-wrap break-words text-ink/90">{t.notes}</p> : <p className="mt-1 text-faint">No notes.</p>}
        </div>
      </details>
    </li>
  )
}

export const DraftItem = ({ a, now }: { a: ApprovalRow; now: string }) => {
  const mark = a.status === 'pending' ? 'pending' : a.status
  return (
    <li className="rounded-xl bg-raised">
      <details>
        <summary className="cursor-pointer list-none px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim">
            {a.venture ? <VentureTag venture={a.venture} /> : null}
            <span>{a.channel}</span>
            <span className="ml-auto text-faint">{ago(a.created_at, now)}</span>
          </div>
          {a.recipient ? <p className="mt-1.5 text-[15px] font-medium break-words">To {a.recipient}</p> : null}
          <p className="mt-1 line-clamp-2 text-sm text-dim">{a.draft}</p>
          <p className="mt-2 text-xs">
            <StateMark mark={mark} />
            <span className="ml-2 text-faint">{a.status === 'pending' ? 'tap to read and decide' : 'tap to read'}</span>
          </p>
        </summary>
        <div className="border-t border-line px-4 py-3">
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words">{a.draft}</p>
          {a.result ? <p className="mt-3 text-sm whitespace-pre-wrap break-words text-dim">Result: {a.result}</p> : null}
          {a.status === 'pending' ? (
            <DraftDecision id={a.id} target={`${a.channel}${a.recipient ? ` to ${a.recipient}` : ''}`} />
          ) : null}
          <p className="mt-3 text-xs text-faint">
            Draft #{a.id}
            {a.task_id ? ` for task #${a.task_id}` : ''}
            {a.decided_at ? `, decided ${ago(a.decided_at, now)}` : ''}.
          </p>
        </div>
      </details>
    </li>
  )
}

export const ActivityItem = ({ a, now, showVenture = true }: { a: ActivityRow; now: string; showVenture?: boolean }) => (
  <li className="flex gap-3 py-3">
    <div className="w-[3.9rem] shrink-0 pt-0.5 text-right text-xs whitespace-nowrap text-faint tabular-nums">
      {new Date(now).getTime() - new Date(a.at).getTime() < 20 * 3600 * 1000 ? fmtTime(a.at) : fmtDate(a.at)}
    </div>
    <div className="min-w-0 flex-1">
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-dim">
        {showVenture ? <VentureTag venture={a.venture} /> : null}
        <span>{a.channel}</span>
        <span className="text-faint break-all">{a.account}</span>
      </p>
      <p className="mt-1 text-sm leading-snug break-words">{a.action}</p>
      {a.result ? <p className="mt-1 text-sm leading-snug break-words text-dim">{a.result}</p> : null}
    </div>
  </li>
)

const runLength = (r: RunRow): string => {
  if (!r.finished_at) return 'still running'
  const s = Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)} min`
}

export const RunItem = ({ r, now }: { r: RunRow; now: string }) => (
  <li className="rounded-xl bg-raised">
    <details>
      <summary className="cursor-pointer list-none px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim">
          {r.venture ? <VentureTag venture={r.venture} /> : null}
          <span className="ml-auto text-faint">{ago(r.started_at, now)}</span>
        </div>
        <p className="mt-1.5 text-[15px] leading-snug break-words">{r.task_title ?? 'No task'}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 text-xs text-dim">
          {r.status === 'error' && /usage limit|hour limit/i.test(r.summary ?? '') ? (
            <StateMark mark="skipped" text="hit the usage limit, did not start" />
          ) : (
            <StateMark mark={r.status} />
          )}
          <span>{runLength(r)}</span>
          <span className="tabular-nums">{r.cost_usd !== null ? money(r.cost_usd) : 'cost not recorded'}</span>
        </p>
      </summary>
      <div className="border-t border-line px-4 py-3">
        {r.summary ? <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{r.summary}</p> : <p className="text-sm text-faint">No summary saved.</p>}
        <p className="mt-3 text-xs text-faint">Run {r.id}{r.task_id ? ` for task #${r.task_id}` : ''}</p>
      </div>
    </details>
  </li>
)

const goalName = (title: string): string => {
  const t = title.replace(/^[^:]+:\s*/, '')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

export const GoalBar = ({ g, pace }: { g: GoalRow; pace: number }) => {
  const pct = g.target > 0 ? Math.min(100, (g.current / g.target) * 100) : 0
  const pacePct = g.target > 0 ? Math.min(100, (pace / g.target) * 100) : 0
  const behind = g.current + 1e-9 < Math.floor(pace)
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm leading-snug">{goalName(g.title)}</p>
        <p className="shrink-0 text-sm font-semibold tabular-nums">
          {g.current} <span className="font-normal text-faint">of {g.target}</span>
        </p>
      </div>
      <div className="relative mt-2 h-1.5 rounded-full bg-lift" role="img" aria-label={`${g.current} of ${g.target}; on pace would be ${pace.toFixed(1)}`}>
        <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 1.5)}%`, background: ventureMeta(g.venture).color }} />
        <div className="absolute -top-1 h-3.5 w-0.5 rounded bg-ink/70" style={{ left: `calc(${pacePct}% - 1px)` }} />
      </div>
      <p className="mt-1.5 text-xs text-dim">
        Due {fmtDay(g.due_at)}.{' '}
        {behind ? (
          <StateMark mark="late" text={`Behind: on pace would be about ${Math.floor(pace)}`} />
        ) : (
          <span>On pace.</span>
        )}
      </p>
    </div>
  )
}
