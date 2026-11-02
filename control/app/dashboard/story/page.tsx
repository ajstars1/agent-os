import type { ReactNode } from 'react'
import { goalPace, loadStory, type StoryData } from '../../../lib/dash'
import { ago, fmtDay } from '../../../lib/time'
import { ventureMeta } from '../../../lib/ventures'
import { Figure, Heading, VentureTag, money } from '../_ui/bits'
import { CopyLine } from '../_ui/copy-line'
import { DayBars } from '../_ui/day-bars'
import { safeLoad } from '../_ui/load'
import { LoadError, PageHead } from '../_ui/page-head'
import { GoalBar } from '../_ui/rows'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'aos · story' }

const pct = (a: number, b: number): string => (b > 0 ? `${Math.round((a / b) * 100)}%` : '–')
const N = ({ children }: { children: ReactNode }) => <span className="font-semibold text-ink tabular-nums">{children}</span>

// Sentences built only from counted rows, so they can be pasted into a post as they are.
const lines = (s: StoryData): string[] => {
  const decided = s.drafts.total - s.drafts.pending
  const active = s.ventures.filter((v) => v.touches + v.done > 0).length
  return [
    `In ${s.days} days, aos completed ${s.runs.ok} unattended work sessions, about ${s.runs.hours.toFixed(1)} hours of agent time, across ${active} ventures.`,
    `aos drafted ${s.drafts.total} outreach messages. A person approved ${s.drafts.approved} of the ${decided} decided so far (${pct(s.drafts.approved, decided)}), and nothing went out without that yes.`,
    `${s.outreach.touches} outreach touches to ${s.outreach.people} people and companies over ${s.outreach.channels.length} channels, each one logged.`,
    `${s.tasks.doneByAos} of the ${s.tasks.done} tasks finished so far were done by aos itself.`,
    `A completed aos work session costs about ${money(s.runs.ok ? s.runs.cost / s.runs.ok : 0)} on average.`,
  ]
}

const StoryPage = async () => {
  const res = await safeLoad(() => loadStory())
  if (!res.ok) return <LoadError message={res.message} />
  const s = res.data
  const now = new Date()
  const decided = s.drafts.total - s.drafts.pending
  const maxChannel = Math.max(1, ...s.outreach.channels.map((c) => c.count))

  return (
    <main>
      <PageHead now={s.computedAt} title="What aos has done">
        <p className="mt-1 text-sm text-faint">
          Since {fmtDay(s.since)}. Numbers refresh every 30 minutes (last {ago(s.computedAt, now.toISOString())}).
        </p>
        <p className="mt-5 text-[22px] leading-snug text-dim">
          In <N>{s.days} days</N> aos completed <N>{s.runs.ok}</N> work sessions on its own, made <N>{s.outreach.touches}</N> outreach
          touches to <N>{s.outreach.people}</N> people and companies, and sent <N>{s.drafts.sent}</N> messages you approved.
        </p>
      </PageHead>

      <Heading>Outreach</Heading>
      <div className="grid grid-cols-3 gap-4">
        <Figure value={s.outreach.touches} label="touches" />
        <Figure value={s.outreach.people} label="people or companies reached" />
        <Figure value={s.outreach.conversations} label="contacted twice or more" />
      </div>
      <ul className="mt-5 space-y-2.5" aria-label="Touches by channel">
        {s.outreach.channels.map((c) => (
          <li key={c.name} className="grid grid-cols-[6.5rem_1fr_2rem] items-center gap-3 text-sm">
            <span className="truncate text-dim">{c.name}</span>
            <span className="h-2 rounded-full bg-lift">
              <span className="block h-full rounded-full bg-[#3987e5]" style={{ width: `${(c.count / maxChannel) * 100}%` }} />
            </span>
            <span className="text-right tabular-nums">{c.count}</span>
          </li>
        ))}
      </ul>

      <Heading>Drafts and your yes</Heading>
      <div className="grid grid-cols-3 gap-4">
        <Figure value={s.drafts.total} label="drafts written" />
        <Figure value={pct(s.drafts.approved, decided)} label="approved by you" />
        <Figure value={s.drafts.sent} label="sent and verified" />
      </div>
      <p className="mt-3 text-sm text-dim">
        {s.drafts.rejected} rejected, {s.drafts.failed} could not be delivered, {s.drafts.pending} waiting. aos never sends on its own: a
        draft goes out only after you say yes.
      </p>

      <Heading>Work done</Heading>
      <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
        <Figure value={s.tasks.done} label="tasks finished" />
        <Figure value={s.runs.ok} label="aos sessions completed" />
        <Figure value={s.runs.hours.toFixed(1)} label="agent hours" />
        <Figure value={money(s.runs.cost)} label="total run cost" />
      </div>

      <div className="mt-6 space-y-3">
        <DayBars title="Outreach touches per day" unit="touches" color="#3987e5" points={s.daily.map((p) => ({ day: p.day, value: p.touches }))} />
        <DayBars title="Completed aos sessions per day" unit="sessions" color="#3987e5" points={s.daily.map((p) => ({ day: p.day, value: p.runs }))} />
        <DayBars title="Tasks finished per day" unit="tasks" color="#3987e5" points={s.daily.map((p) => ({ day: p.day, value: p.done }))} />
      </div>

      <Heading>By venture</Heading>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-faint">
            <th className="py-2 font-normal">Venture</th>
            <th className="py-2 text-right font-normal">Touches</th>
            <th className="py-2 text-right font-normal">Tasks done</th>
            <th className="py-2 text-right font-normal">Drafts</th>
          </tr>
        </thead>
        <tbody>
          {s.ventures.map((v) => (
            <tr key={v.venture} className="border-t border-line">
              <td className="py-2.5">
                <a href={`/dashboard/v/${encodeURIComponent(v.venture)}`}>
                  <VentureTag venture={v.venture} />
                </a>
              </td>
              <td className="py-2.5 text-right tabular-nums">{v.touches}</td>
              <td className="py-2.5 text-right tabular-nums">{v.done}</td>
              <td className="py-2.5 text-right tabular-nums">{v.drafts}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {s.goals.length > 0 ? (
        <>
          <Heading>Goals</Heading>
          <div className="space-y-5">
            {s.goals.map((g) => (
              <div key={g.id}>
                <p className="mb-1 text-xs text-faint">{ventureMeta(g.venture).name}</p>
                <GoalBar g={g} pace={goalPace(g, now)} />
              </div>
            ))}
          </div>
        </>
      ) : null}

      <Heading>Lines for a post</Heading>
      <p className="text-sm text-dim">Built straight from the counts above. Copy one into LinkedIn or a pitch.</p>
      <ul className="mt-1 divide-y divide-line">
        {lines(s).map((l) => (
          <CopyLine key={l} text={l} />
        ))}
      </ul>

      <Heading>Reliability</Heading>
      <p className="text-sm leading-relaxed text-dim">
        {s.runs.total} sessions started, {s.runs.ok} completed. {s.runs.limitHits} of the {s.runs.total - s.runs.ok} that stopped hit the
        Claude plan&apos;s 5-hour usage limit before doing any work
        {s.runs.limitHits === s.runs.total - s.runs.ok ? '; none failed on the task itself.' : `; ${s.runs.total - s.runs.ok - s.runs.limitHits} failed for other reasons.`}
      </p>
    </main>
  )
}

export default StoryPage
