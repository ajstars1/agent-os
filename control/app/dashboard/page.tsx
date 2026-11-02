import Link from 'next/link'
import { goalPace, loadToday, type TodayData } from '../../lib/dash'
import { fmtDay, whenBucket } from '../../lib/time'
import { ventureMeta } from '../../lib/ventures'
import { Empty, Figure, Heading, VentureDot, money } from './_ui/bits'
import { safeLoad } from './_ui/load'
import { LoadError, PageHead } from './_ui/page-head'
import { ActivityItem, DraftItem, TaskItem } from './_ui/rows'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'aos · today' }

const greeting = (iso: string): string => {
  const h = Number(new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }))
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

// The one-paragraph brief: what needs Ayush, what waits on him, what aos did.
const brief = (d: TodayData): string => {
  const late = d.mine.filter((t) => whenBucket(t.due_at, d.now) === 'overdue').length
  const parts: string[] = []
  parts.push(
    d.mine.length === 0
      ? 'Nothing is due from you today.'
      : `${plural(d.mine.length, 'thing')} need${d.mine.length === 1 ? 's' : ''} you${late ? `, ${late} of them late` : ''}.`,
  )
  parts.push(
    d.approvals.length === 0
      ? 'No drafts are waiting for your yes.'
      : `${plural(d.approvals.length, 'draft')} ${d.approvals.length === 1 ? 'is' : 'are'} waiting for your yes.`,
  )
  const doneByAos = d.doneToday.filter((t) => t.owner === 'claude').length
  parts.push(
    d.runsToday.count === 0 && doneByAos === 0
      ? 'aos has not run anything yet today.'
      : `aos has closed ${plural(doneByAos, 'task')} and made ${plural(d.touchesToday, 'outreach touch', 'outreach touches')} today.`,
  )
  return parts.join(' ')
}

const TodayPage = async () => {
  const res = await safeLoad(() => loadToday())
  if (!res.ok) return <LoadError message={res.message} />
  const d = res.data
  const now = new Date(d.now)
  const goals = d.ventures.flatMap((v) => v.goals)

  return (
    <main>
      <PageHead now={d.now} title={`${greeting(d.now)}, Ayush.`}>
        <p className="mt-1 text-sm text-faint">{fmtDay(d.now)}</p>
        <p className="mt-4 max-w-[34ch] text-xl leading-snug text-dim">{brief(d)}</p>
      </PageHead>

      <Heading count={d.mine.length} action={<Link href="/dashboard/tasks?who=me" prefetch={false}>All my tasks</Link>}>
        Needs you
      </Heading>
      {d.mine.length === 0 ? (
        <Empty>Clear for today. Anything new shows up here when it is due.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {d.mine.map((t) => (
            <TaskItem key={t.id} t={t} now={d.now} />
          ))}
        </ul>
      )}

      {d.approvals.length > 0 ? (
        <>
          <Heading count={d.approvals.length}>Waiting for your yes</Heading>
          <ul className="space-y-2">
            {d.approvals.map((a) => (
              <DraftItem key={a.id} a={a} now={d.now} />
            ))}
          </ul>
        </>
      ) : null}

      <Heading action={<Link href="/dashboard/log" prefetch={false}>Full log</Link>}>aos today</Heading>
      <div className="grid grid-cols-2 gap-x-4 gap-y-5 rounded-xl bg-raised p-4 sm:grid-cols-4">
        <Figure value={d.doneToday.filter((t) => t.owner === 'claude').length} label="tasks closed" />
        <Figure value={d.touchesToday} label="outreach touches" />
        <Figure value={`${d.runsToday.ok}/${d.runsToday.count}`} label="runs finished clean" />
        <Figure value={money(d.runsToday.cost)} label="spent on runs" />
      </div>
      {d.aosDue.length > 0 ? (
        <details className="mt-3 rounded-xl border border-line">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm text-dim">
            aos has {plural(d.aosDue.length, 'task')} due or late in its queue <span className="text-faint">· show</span>
          </summary>
          <ul className="divide-y divide-line border-t border-line px-4">
            {d.aosDue.map((t) => (
              <TaskItem key={t.id} t={t} now={d.now} />
            ))}
          </ul>
        </details>
      ) : null}

      {d.team.length > 0 ? (
        <>
          <Heading count={d.team.length}>Others are on</Heading>
          <ul className="divide-y divide-line">
            {d.team.map((t) => (
              <TaskItem key={t.id} t={t} now={d.now} />
            ))}
          </ul>
        </>
      ) : null}

      <Heading action={<Link href="/dashboard/v" prefetch={false}>All ventures</Link>}>Ventures</Heading>
      <ul className="divide-y divide-line">
        {d.ventures
          .filter((v) => v.open > 0 || v.doneLast7 > 0 || v.goals.length > 0)
          .map((v) => (
            <li key={v.venture}>
              <Link href={`/dashboard/v/${encodeURIComponent(v.venture)}`} prefetch={false} className="flex items-center gap-3 py-3">
                <VentureDot venture={v.venture} size={10} />
                <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{ventureMeta(v.venture).name}</span>
                <span className="text-sm text-dim tabular-nums">
                  {v.open} open
                  {v.overdue > 0 ? <span className="text-late"> · {v.overdue} late</span> : null}
                </span>
                <span aria-hidden="true" className="text-faint">›</span>
              </Link>
            </li>
          ))}
      </ul>

      {goals.length > 0 ? (
        <>
          <Heading>Goals</Heading>
          <ul className="space-y-3">
            {goals.map((g) => {
              const pace = goalPace(g, now)
              return (
                <li key={g.id} className="flex items-center gap-3 text-sm">
                  <VentureDot venture={g.venture} />
                  <span className="min-w-0 flex-1 leading-snug">{g.title}</span>
                  <span className={`shrink-0 tabular-nums ${g.current < Math.floor(pace) ? 'text-late' : 'text-dim'}`}>
                    {g.current}/{g.target}
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      ) : null}

      <Heading action={<Link href="/dashboard/log" prefetch={false}>More</Link>}>Latest from aos</Heading>
      <ul className="divide-y divide-line">
        {d.latest.map((a) => (
          <ActivityItem key={a.id} a={a} now={d.now} />
        ))}
      </ul>
    </main>
  )
}

export default TodayPage
