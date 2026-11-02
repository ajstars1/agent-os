import type { ReactNode } from 'react'
import type { Approval, TaskStatus } from '../../lib/db'
import type { ActivityRow, OpenTask, RunRow, TaskGroup, VentureCard } from '../../lib/dashboard'

const IST = 'Asia/Kolkata'

export const fmtWhen = (iso: string | null): string => {
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

export const ago = (iso: string | null, nowIso: string): string => {
  if (!iso) return 'never'
  const s = Math.max(0, (new Date(nowIso).getTime() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const STATUS_STYLE: Record<string, string> = {
  todo: 'bg-zinc-800 text-zinc-300 ring-zinc-700',
  doing: 'bg-sky-950 text-sky-300 ring-sky-800',
  waiting_approval: 'bg-amber-950 text-amber-300 ring-amber-800',
  pending: 'bg-amber-950 text-amber-300 ring-amber-800',
  approved: 'bg-sky-950 text-sky-300 ring-sky-800',
  sent: 'bg-emerald-950 text-emerald-300 ring-emerald-800',
  ok: 'bg-emerald-950 text-emerald-300 ring-emerald-800',
  failed: 'bg-red-950 text-red-300 ring-red-800',
  error: 'bg-red-950 text-red-300 ring-red-800',
  timeout: 'bg-orange-950 text-orange-300 ring-orange-800',
  running: 'bg-sky-950 text-sky-300 ring-sky-800',
}

export const Chip = ({ label, tone }: { label: string; tone?: string }) => (
  <span
    className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
      STATUS_STYLE[tone ?? label] ?? 'bg-zinc-800 text-zinc-400 ring-zinc-700'
    }`}
  >
    {label.replace('_', ' ')}
  </span>
)

export const Section = ({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) => (
  <section id={id} className="pt-6">
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {aside ? <div className="text-xs text-zinc-500">{aside}</div> : null}
    </div>
    {children}
  </section>
)

export const Empty = ({ children }: { children: ReactNode }) => (
  <p className="rounded-lg border border-dashed border-zinc-800 px-3 py-4 text-sm text-zinc-500">{children}</p>
)

const TaskLine = ({ t, overdue }: { t: OpenTask; overdue: boolean }) => (
  <li className="flex flex-col gap-1 py-2">
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0 font-mono text-xs text-zinc-500">#{t.id}</span>
      <span className="min-w-0 flex-1 text-sm leading-snug break-words">{t.title}</span>
    </div>
    <div className="flex flex-wrap items-center gap-1.5 pl-7 text-xs text-zinc-500">
      <Chip label={t.status as TaskStatus} />
      <span className={overdue ? 'text-red-400' : ''}>{fmtWhen(t.due_at)}</span>
      {t.recur ? <span>↻ {t.recur}</span> : null}
      {t.auto ? <span className="text-zinc-400">auto</span> : null}
    </div>
  </li>
)

export const TaskBucket = ({
  title,
  groups,
  total,
  tone,
  overdue = false,
  collapsed = false,
}: {
  title: string
  groups: TaskGroup[]
  total: number
  tone: string
  overdue?: boolean
  collapsed?: boolean
}) => (
  <details open={!collapsed} className="group mb-3 rounded-xl border border-zinc-800 bg-zinc-900/40">
    <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 select-none">
      <span className={`text-sm font-semibold ${tone}`}>
        {title} <span className="text-zinc-500">({total})</span>
      </span>
      <span className="text-xs text-zinc-500 transition group-open:rotate-90">›</span>
    </summary>
    {groups.length === 0 ? (
      <p className="px-3 pb-3 text-sm text-zinc-500">Nothing here.</p>
    ) : (
      <div className="divide-y divide-zinc-800 border-t border-zinc-800">
        {groups.map((g) => (
          <div key={g.venture} className="px-3 py-2">
            <h3 className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">{g.venture}</h3>
            {g.owners.map((o) => (
              <div key={o.owner} className="mt-1">
                <p className="text-[11px] text-zinc-500">{o.owner}</p>
                <ul className="divide-y divide-zinc-800/60">
                  {o.tasks.map((t) => (
                    <TaskLine key={t.id} t={t} overdue={overdue} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))}
      </div>
    )}
  </details>
)

export const ApprovalCard = ({ a }: { a: Approval }) => (
  <li className="rounded-xl border border-zinc-800 bg-zinc-900/40">
    <details>
      <summary className="cursor-pointer list-none px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs text-zinc-500">#{a.id}</span>
          <Chip label={a.status} />
          <span className="text-xs text-zinc-400">{a.channel}</span>
          {a.task_id ? <span className="text-xs text-zinc-500">task #{a.task_id}</span> : null}
          <span className="ml-auto text-xs text-zinc-500">{fmtWhen(a.created_at)}</span>
        </div>
        {a.recipient ? <p className="mt-1 text-sm break-words text-zinc-200">→ {a.recipient}</p> : null}
        <p className="mt-1 line-clamp-2 text-sm text-zinc-400">{a.draft}</p>
      </summary>
      <div className="border-t border-zinc-800 px-3 py-3">
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-zinc-100">{a.draft}</p>
        {a.result ? (
          <p className="mt-3 text-xs break-words whitespace-pre-wrap text-zinc-400">
            <span className="text-zinc-500">Result: </span>
            {a.result}
          </p>
        ) : null}
        {a.decided_at ? <p className="mt-2 text-xs text-zinc-500">Decided {fmtWhen(a.decided_at)}</p> : null}
      </div>
    </details>
  </li>
)

export const VentureTile = ({ v, now }: { v: VentureCard; now: string }) => (
  <li className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
    <div className="flex items-center justify-between gap-2">
      <h3 className="truncate text-sm font-semibold">{v.venture}</h3>
      {v.overdue > 0 ? <Chip label={`${v.overdue} overdue`} tone="failed" /> : null}
    </div>
    <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
      <div>
        <dt className="text-[11px] text-zinc-500">open</dt>
        <dd className="text-lg font-semibold tabular-nums">{v.open}</dd>
      </div>
      <div>
        <dt className="text-[11px] text-zinc-500">overdue</dt>
        <dd className={`text-lg font-semibold tabular-nums ${v.overdue ? 'text-red-400' : ''}`}>{v.overdue}</dd>
      </div>
      <div>
        <dt className="text-[11px] text-zinc-500">done 7d</dt>
        <dd className="text-lg font-semibold text-emerald-400 tabular-nums">{v.doneLast7}</dd>
      </div>
    </dl>
    <p className="mt-2 text-[11px] text-zinc-500">Last activity {ago(v.lastActivity, now)}</p>
  </li>
)

export const ActivityItem = ({ a, now }: { a: ActivityRow; now: string }) => (
  <li className="py-2.5">
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
      <span className="font-medium text-zinc-300">{a.venture}</span>
      <span>· {a.channel}</span>
      <span className="ml-auto" title={fmtWhen(a.at)}>
        {ago(a.at, now)}
      </span>
    </div>
    <p className="mt-0.5 text-xs break-words text-zinc-400">{a.account}</p>
    <p className="mt-1 text-sm leading-snug break-words">{a.action}</p>
    {a.result ? <p className="mt-1 text-xs break-words text-zinc-400">→ {a.result}</p> : null}
  </li>
)

const duration = (r: RunRow): string => {
  if (!r.finished_at) return '–'
  const s = Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export const RunItem = ({ r, now }: { r: RunRow; now: string }) => (
  <li className="rounded-xl border border-zinc-800 bg-zinc-900/40">
    <details>
      <summary className="cursor-pointer list-none px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-mono text-zinc-500">run {r.id}</span>
          <Chip label={r.status} />
          <span className="text-zinc-500">{r.trigger}</span>
          <span className="ml-auto text-zinc-400 tabular-nums">
            {r.cost_usd !== null ? `$${r.cost_usd.toFixed(2)}` : 'no cost'} · {duration(r)}
          </span>
        </div>
        <p className="mt-1 text-sm leading-snug break-words">
          {r.task_id ? <span className="text-zinc-500">#{r.task_id} </span> : null}
          {r.task?.title ?? 'No task'}
        </p>
        <p className="mt-0.5 text-[11px] text-zinc-500">
          {r.task?.venture ? `${r.task.venture} · ` : ''}
          {ago(r.started_at, now)}
        </p>
      </summary>
      {r.summary ? (
        <div className="border-t border-zinc-800 px-3 py-3">
          <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-zinc-200">{r.summary}</p>
        </div>
      ) : null}
    </details>
  </li>
)
