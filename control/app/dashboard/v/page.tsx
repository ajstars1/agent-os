import Link from 'next/link'
import { goalPace, loadVentures } from '../../../lib/dash'
import { ago } from '../../../lib/time'
import { ventureMeta } from '../../../lib/ventures'
import { VentureDot } from '../_ui/bits'
import { safeLoad } from '../_ui/load'
import { LoadError, PageHead } from '../_ui/page-head'
import { GoalBar } from '../_ui/rows'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'aos · ventures' }

const VenturesPage = async () => {
  const res = await safeLoad(() => loadVentures())
  if (!res.ok) return <LoadError message={res.message} />
  const { now, ventures } = res.data
  return (
    <main>
      <PageHead now={now} title="Ventures">
        <p className="mt-2 text-sm text-dim">Tap one for its tasks, outreach, drafts and runs.</p>
      </PageHead>
      <ul className="mt-6 space-y-3">
        {ventures.map((v) => {
          const m = ventureMeta(v.venture)
          const quiet = v.open === 0 && v.doneLast7 === 0 && v.touches7 === 0
          return (
            <li key={v.venture}>
              <Link
                href={`/dashboard/v/${encodeURIComponent(v.venture)}`}
                prefetch={false}
                className={`block rounded-2xl bg-raised p-4 active:bg-lift ${quiet ? 'opacity-60' : ''}`}
                style={{ boxShadow: `inset 3px 0 0 ${m.color}` }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                      <VentureDot venture={v.venture} size={10} />
                      {m.name}
                    </h2>
                    {m.blurb ? <p className="mt-0.5 text-sm text-dim">{m.blurb}</p> : null}
                  </div>
                  <span aria-hidden="true" className="pt-1 text-faint">›</span>
                </div>
                <dl className="mt-4 grid grid-cols-4 gap-2">
                  {[
                    { k: 'open', v: v.open, tone: '' },
                    { k: 'late', v: v.overdue, tone: v.overdue ? 'text-late' : '' },
                    { k: 'done, 7 days', v: v.doneLast7, tone: '' },
                    { k: 'touches, 7 days', v: v.touches7, tone: '' },
                  ].map((s) => (
                    <div key={s.k}>
                      <dd className={`text-xl font-semibold tabular-nums ${s.tone}`}>{s.v}</dd>
                      <dt className="text-[11px] leading-tight text-faint">{s.k}</dt>
                    </div>
                  ))}
                </dl>
                {v.goals.length > 0 ? (
                  <div className="mt-4 space-y-4 border-t border-line pt-4">
                    {v.goals.map((g) => (
                      <GoalBar key={g.id} g={g} pace={goalPace(g, new Date(now))} />
                    ))}
                  </div>
                ) : null}
                <p className="mt-3 text-xs text-faint">
                  {v.mine > 0 ? `${v.mine} on you · ` : ''}last moved {ago(v.lastActivity, now)}
                </p>
              </Link>
            </li>
          )
        })}
      </ul>
    </main>
  )
}

export default VenturesPage
