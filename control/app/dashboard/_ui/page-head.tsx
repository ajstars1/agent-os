import type { ReactNode } from 'react'
import { fmtTime } from '../../../lib/time'

// Title row with the freshness stamp and the only refresh control (a plain reload: no polling anywhere).
export const PageHead = ({ title, now, back, children }: { title: ReactNode; now: string; back?: { href: string; label: string }; children?: ReactNode }) => (
  <header className="pt-5">
    <div className="flex items-center justify-between gap-3 text-xs text-faint">
      {back ? (
        <a href={back.href} className="-ml-1 rounded px-1 py-1 text-dim">
          ‹ {back.label}
        </a>
      ) : (
        <span>Updated {fmtTime(now)}</span>
      )}
      <a href="" className="rounded-md border border-line px-2.5 py-1 text-dim active:bg-raised" aria-label="Reload this page">
        Refresh
      </a>
    </div>
    <h1 className="mt-4 text-[28px] leading-tight font-semibold tracking-tight">{title}</h1>
    {children}
  </header>
)

export const LoadError = ({ message }: { message: string }) => (
  <div className="mt-8 rounded-xl border border-late/40 bg-late/10 p-4 text-sm">
    <p className="font-medium text-late">{message}</p>
    <p className="mt-1 text-dim">The database did not answer. Tap Refresh in a minute; if it keeps failing, check Supabase.</p>
  </div>
)
