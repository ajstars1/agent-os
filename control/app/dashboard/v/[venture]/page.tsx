import { notFound } from 'next/navigation'
import { goalPace, loadVenture } from '../../../../lib/dash'
import { ago } from '../../../../lib/time'
import { isVentureKey, ventureMeta } from '../../../../lib/ventures'
import { Empty, Figure, VentureDot, money } from '../../_ui/bits'
import { parseFilters } from '../../_ui/filters'
import { safeLoad } from '../../_ui/load'
import { LoadError, PageHead } from '../../_ui/page-head'
import { ActivityItem, DraftItem, GoalBar, RunItem } from '../../_ui/rows'
import { TaskBrowser } from '../../_ui/task-browser'
import { Tabs } from '../../_ui/tabs'

export const dynamic = 'force-dynamic'

type Params = { venture: string }
type Search = Record<string, string | string[] | undefined>

export const generateMetadata = async ({ params }: { params: Promise<Params> }) => {
  const { venture } = await params
  return { title: `aos · ${ventureMeta(decodeURIComponent(venture)).name}` }
}

const VenturePage = async ({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<Search> }) => {
  const [{ venture: raw }, sp] = await Promise.all([params, searchParams])
  const venture = decodeURIComponent(raw)
  if (!isVentureKey(venture)) notFound()
  const res = await safeLoad(() => loadVenture(venture))
  if (!res.ok) return <LoadError message={res.message} />
  const d = res.data
  const m = ventureMeta(venture)
  const now = new Date(d.now)
  const pending = d.approvals.filter((a) => a.status === 'pending')
  const tab = typeof sp.tab === 'string' ? sp.tab : undefined

  return (
    <main>
      <PageHead
        now={d.now}
        back={{ href: '/dashboard/v', label: 'Ventures' }}
        title={
          <span className="flex items-center gap-2.5">
            <VentureDot venture={venture} size={12} />
            {m.name}
          </span>
        }
      >
        {m.blurb ? <p className="mt-1 text-dim">{m.blurb}</p> : null}
        <p className="mt-1 text-xs text-faint">Last moved {ago(d.stat.lastActivity, d.now)}</p>
      </PageHead>

      {d.stat.goals.length > 0 ? (
        <section className="mt-6 space-y-5 rounded-2xl bg-raised p-4" aria-label="Goals">
          {d.stat.goals.map((g) => (
            <GoalBar key={g.id} g={g} pace={goalPace(g, now)} />
          ))}
        </section>
      ) : null}

      <section className="mt-6 grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4" aria-label="This week">
        <Figure value={d.stat.open} label="open tasks" />
        <Figure value={d.stat.overdue} label="late" tone={d.stat.overdue ? 'text-late' : ''} />
        <Figure value={d.stat.doneLast7} label="done in 7 days" />
        <Figure value={d.stat.touches7} label="touches in 7 days" />
      </section>
      <p className="mt-4 text-sm leading-relaxed text-dim">
        Since the start: {d.totals.touches} outreach touches to {d.totals.people} people or companies, {d.totals.sent} approved messages sent,{' '}
        {d.totals.done} tasks done, {d.totals.runs} aos runs ({money(d.totals.cost)}).
      </p>

      <div className="mt-6">
        <Tabs
          sticky={false}
          initial={tab}
          panels={[
            {
              key: 'tasks',
              label: 'Tasks',
              count: d.stat.open,
              content: <TaskBrowser tasks={d.tasks} now={d.now} initial={parseFilters(sp, venture)} lockVenture />,
            },
            {
              key: 'outreach',
              label: 'Outreach',
              count: d.activity.length,
              content:
                d.activity.length === 0 ? (
                  <Empty>No outreach logged for {m.name} yet.</Empty>
                ) : (
                  <ul className="divide-y divide-line">
                    {d.activity.map((a) => (
                      <ActivityItem key={a.id} a={a} now={d.now} showVenture={false} />
                    ))}
                  </ul>
                ),
            },
            {
              key: 'drafts',
              label: pending.length ? `Drafts (${pending.length} waiting)` : 'Drafts',
              count: pending.length ? undefined : d.approvals.length,
              content:
                d.approvals.length === 0 ? (
                  <Empty>No drafts for {m.name} yet.</Empty>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {d.approvals.map((a) => (
                      <DraftItem key={a.id} a={a} now={d.now} />
                    ))}
                  </ul>
                ),
            },
            {
              key: 'runs',
              label: 'Runs',
              count: d.runs.length,
              content:
                d.runs.length === 0 ? (
                  <Empty>aos has not run anything for {m.name} yet.</Empty>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {d.runs.map((r) => (
                      <RunItem key={r.id} r={r} now={d.now} />
                    ))}
                  </ul>
                ),
            },
          ]}
        />
      </div>
    </main>
  )
}

export default VenturePage
