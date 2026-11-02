// Small presentational pieces shared by server pages and client browsers. No hooks, no server-only imports.
import type { ReactNode } from 'react'
import type { TaskStatus } from '../../../lib/db'
import { ventureMeta } from '../../../lib/ventures'

export const VentureDot = ({ venture, size = 8 }: { venture: string; size?: number }) => (
  <span
    aria-hidden="true"
    className="inline-block shrink-0 rounded-full"
    style={{ width: size, height: size, background: ventureMeta(venture).color }}
  />
)

export const VentureTag = ({ venture, className = '' }: { venture: string; className?: string }) => (
  <span className={`inline-flex items-center gap-1.5 ${className}`}>
    <VentureDot venture={venture} />
    <span>{ventureMeta(venture).name}</span>
  </span>
)

type Mark = 'late' | 'waiting' | 'doing' | 'done' | 'skipped' | 'failed' | 'sent' | 'error' | 'ok' | 'pending' | 'rejected' | 'approved' | 'running' | 'timeout'

const MARKS: Record<Mark, { label: string; cls: string; glyph: string }> = {
  late: { label: 'late', cls: 'text-late', glyph: '!' },
  waiting: { label: 'needs your yes', cls: 'text-wait', glyph: '?' },
  pending: { label: 'needs your yes', cls: 'text-wait', glyph: '?' },
  doing: { label: 'in progress', cls: 'text-busy', glyph: '›' },
  running: { label: 'running', cls: 'text-busy', glyph: '›' },
  approved: { label: 'approved, sending', cls: 'text-busy', glyph: '›' },
  done: { label: 'done', cls: 'text-good', glyph: '✓' },
  ok: { label: 'finished', cls: 'text-good', glyph: '✓' },
  sent: { label: 'sent', cls: 'text-good', glyph: '✓' },
  skipped: { label: 'skipped', cls: 'text-faint', glyph: '–' },
  rejected: { label: 'rejected', cls: 'text-faint', glyph: '×' },
  failed: { label: 'failed', cls: 'text-late', glyph: '×' },
  error: { label: 'stopped with an error', cls: 'text-late', glyph: '×' },
  timeout: { label: 'timed out', cls: 'text-late', glyph: '×' },
}

export const StateMark = ({ mark, text }: { mark: Mark; text?: string }) => {
  const m = MARKS[mark]
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${m.cls}`}>
      <span aria-hidden="true" className="inline-grid size-3.5 place-items-center rounded-full border border-current text-[9px] leading-none">
        {m.glyph}
      </span>
      {text ?? m.label}
    </span>
  )
}

export const taskMark = (status: TaskStatus): Mark | null =>
  status === 'waiting_approval' ? 'waiting' : status === 'doing' ? 'doing' : status === 'done' ? 'done' : status === 'skipped' ? 'skipped' : null

export const ownerName = (owner: string): string => (owner === 'claude' ? 'aos' : owner === 'ayush' ? 'You' : owner.charAt(0).toUpperCase() + owner.slice(1))

export const Heading = ({ children, count, action }: { children: ReactNode; count?: number; action?: ReactNode }) => (
  <div className="mt-9 mb-3 flex items-baseline justify-between gap-3">
    <h2 className="text-[17px] font-semibold tracking-tight">
      {children}
      {count !== undefined ? <span className="ml-2 font-normal text-faint tabular-nums">{count}</span> : null}
    </h2>
    {action ? <div className="text-sm text-dim">{action}</div> : null}
  </div>
)

export const Empty = ({ children }: { children: ReactNode }) => <p className="py-3 text-sm text-faint">{children}</p>

export const Figure = ({ value, label, tone = '' }: { value: ReactNode; label: string; tone?: string }) => (
  <div className="min-w-0">
    <div className={`text-2xl font-semibold tracking-tight tabular-nums ${tone}`}>{value}</div>
    <div className="mt-0.5 text-xs text-dim">{label}</div>
  </div>
)

export const money = (n: number): string => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`)
