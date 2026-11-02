import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SESSION_COOKIE, verifySession } from '../../lib/auth'
import { DashboardDataError, loadDashboard, type DashboardData } from '../../lib/dashboard'
import { logout } from '../login/actions'
import { ActivityItem, ApprovalCard, Empty, RunItem, Section, TaskBucket, VentureTile, fmtWhen } from './ui'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'aos · dashboard' }

const NAV = [
  ['today', 'Today'],
  ['approvals', 'Approvals'],
  ['projects', 'Projects'],
  ['activity', 'Activity'],
  ['runs', 'Runs'],
] as const

type Loaded = { ok: true; data: DashboardData } | { ok: false; message: string }

const load = async (): Promise<Loaded> => {
  try {
    return { ok: true, data: await loadDashboard() }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof DashboardDataError ? `Could not load ${err.query}.` : 'Could not load data.',
    }
  }
}

const DashboardPage = async () => {
  // Middleware already guards this route; checked again here so the data never renders without a session.
  const jar = await cookies()
  if (!(await verifySession(jar.get(SESSION_COOKIE)?.value))) redirect('/login')

  const res = await load()

  return (
    <div className="mx-auto max-w-3xl px-4 pb-16">
      <header className="sticky top-0 z-10 -mx-4 border-b border-zinc-800 bg-[#0b0d10]/95 px-4 pt-3 pb-2 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-base font-semibold tracking-tight">aos control</h1>
            <p className="text-[11px] text-zinc-500">{res.ok ? `as of ${fmtWhen(res.data.generatedAt)} IST` : 'load failed'}</p>
          </div>
          <div className="flex items-center gap-2">
            {/* Plain link: a full reload is the only refresh. No polling, no prefetch. */}
            <a
              href="/dashboard"
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 active:bg-zinc-800"
            >
              Refresh
            </a>
            <form action={logout}>
              <button type="submit" className="rounded-lg px-2 py-1.5 text-sm text-zinc-500 active:text-zinc-300">
                Sign out
              </button>
            </form>
          </div>
        </div>
        <nav className="-mx-1 mt-2 flex gap-1 overflow-x-auto text-sm [scrollbar-width:none]">
          {NAV.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="shrink-0 rounded-md px-2.5 py-1 text-zinc-400 active:bg-zinc-800">
              {label}
            </a>
          ))}
        </nav>
      </header>

      {!res.ok ? (
        <div className="mt-6 rounded-xl border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">{res.message}</div>
      ) : (
        <Body data={res.data} />
      )}
    </div>
  )
}

const Body = ({ data }: { data: DashboardData }) => {
  const now = data.generatedAt
  return (
    <>
      <Section id="today" title="Today" aside={`${data.counts.overdue} overdue · ${data.counts.today} today`}>
        <TaskBucket title="Overdue" groups={data.overdue} total={data.counts.overdue} tone="text-red-400" overdue />
        <TaskBucket title="Today" groups={data.today} total={data.counts.today} tone="text-zinc-100" />
        <TaskBucket
          title="Coming up (7 days)"
          groups={data.upcoming}
          total={data.counts.upcoming}
          tone="text-zinc-300"
          collapsed={data.counts.upcoming > 8}
        />
        <TaskBucket title="No date" groups={data.undated} total={data.counts.undated} tone="text-zinc-400" collapsed />
      </Section>

      <Section id="approvals" title="Approvals" aside={`${data.pendingApprovals.length} pending`}>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-amber-300 uppercase">Waiting for your yes</h3>
        {data.pendingApprovals.length === 0 ? (
          <Empty>No drafts waiting.</Empty>
        ) : (
          <ul className="space-y-2">
            {data.pendingApprovals.map((a) => (
              <ApprovalCard key={a.id} a={a} />
            ))}
          </ul>
        )}
        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Recent (approved, sent, failed)</h3>
        {data.recentApprovals.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <ul className="space-y-2">
            {data.recentApprovals.map((a) => (
              <ApprovalCard key={a.id} a={a} />
            ))}
          </ul>
        )}
      </Section>

      <Section id="projects" title="Projects">
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {data.ventures.map((v) => (
            <VentureTile key={v.venture} v={v} now={now} />
          ))}
        </ul>
      </Section>

      <Section id="activity" title="Activity" aside="last 40">
        {data.activity.length === 0 ? (
          <Empty>No activity logged.</Empty>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/40 px-3">
            {data.activity.map((a) => (
              <ActivityItem key={a.id} a={a} now={now} />
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="runs"
        title="Runner runs"
        aside={`7d: ${data.runCost7d.runs} runs · $${data.runCost7d.total.toFixed(2)}`}
      >
        {data.runs.length === 0 ? (
          <Empty>No runs yet.</Empty>
        ) : (
          <ul className="space-y-2">
            {data.runs.map((r) => (
              <RunItem key={r.id} r={r} now={now} />
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}

export default DashboardPage
