import { loadLog } from '../../../lib/dash'
import { Empty, money } from '../_ui/bits'
import { ActivityBrowser } from '../_ui/activity-browser'
import { safeLoad } from '../_ui/load'
import { LoadError, PageHead } from '../_ui/page-head'
import { DraftItem, RunItem } from '../_ui/rows'
import { Tabs } from '../_ui/tabs'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'aos · log' }

const LogPage = async ({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => {
  const [sp, res] = await Promise.all([searchParams, safeLoad(() => loadLog())])
  if (!res.ok) return <LoadError message={res.message} />
  const d = res.data
  const cost = d.runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0)
  const ok = d.runs.filter((r) => r.status === 'ok').length
  return (
    <main>
      <PageHead now={d.now} title="Log">
        <p className="mt-2 text-sm text-dim">What aos and you did, newest first.</p>
      </PageHead>
      <div className="mt-4">
        <Tabs
          initial={typeof sp.tab === 'string' ? sp.tab : undefined}
          panels={[
            { key: 'activity', label: 'Outreach', count: d.activity.length, content: <ActivityBrowser items={d.activity} now={d.now} /> },
            {
              key: 'runs',
              label: 'aos runs',
              count: d.runs.length,
              content: (
                <>
                  <p className="mt-2 mb-3 text-sm text-dim">
                    Last {d.runs.length} runs: {ok} finished clean, {d.runs.length - ok} stopped early. {money(cost)} in total.
                  </p>
                  <ul className="space-y-2">
                    {d.runs.map((r) => (
                      <RunItem key={r.id} r={r} now={d.now} />
                    ))}
                  </ul>
                </>
              ),
            },
            {
              key: 'drafts',
              label: 'Drafts',
              count: d.approvals.length,
              content:
                d.approvals.length === 0 ? (
                  <Empty>No decided drafts yet.</Empty>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {d.approvals.map((a) => (
                      <DraftItem key={a.id} a={a} now={d.now} />
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

export default LogPage
