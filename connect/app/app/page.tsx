import { redirect } from 'next/navigation'
import { goalPace } from '../../lib/agenda'
import { channelEnv } from '../../lib/env'
import { listApprovals, loadAgenda, phoneLink, type PhoneLink } from '../../lib/store'
import { signedIn, siteOrigin } from '../../lib/supabase-server'
import { fmtDay, fmtWhen } from '../../lib/time'
import type { Approval, Goal, Task } from '../../lib/types'
import { ConnectSteps } from './_ui/connect-steps'
import { connectTelegram, decideDraft, disconnectApp, disconnectPhone, saveTimeZone } from './actions'

export const metadata = { title: 'aos · today', robots: { index: false, follow: false } }
export const dynamic = 'force-dynamic'

const MESSAGES: Record<string, string> = {
  input: 'That did not go through. Try again.',
  decide: 'Could not save your decision. The draft may already be decided. Reload and check.',
  disconnect: 'Could not disconnect that app. Try again.',
  zone: 'That time zone is not known. Use a name like Asia/Kolkata or Europe/London.',
  connect: 'The connection request did not work. Start again from your AI app.',
  phone: 'Could not connect or disconnect your phone. Try again in a minute.',
}

const Section = ({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) => (
  <section className="mt-8">
    <h2 className="flex items-baseline gap-2 text-sm font-medium text-dim">
      {title}
      {count !== undefined ? <span className="text-faint">{count}</span> : null}
    </h2>
    <div className="mt-3">{children}</div>
  </section>
)

const Empty = ({ text }: { text: string }) => <p className="rounded-xl border border-dashed border-line p-4 text-sm text-faint">{text}</p>

const where = (a: Approval): string => `${a.channel}${a.recipient ? ` to ${a.recipient}` : ''}`

const Draft = ({ a, tz }: { a: Approval; tz: string }) => (
  <li className="rounded-xl border border-line bg-raised p-4">
    <p className="text-xs text-faint">
      #{a.id} · {where(a)}
      {a.send_after ? ` · goes out no earlier than ${fmtWhen(a.send_after, tz)}` : ''}
    </p>
    <p className="mt-2 whitespace-pre-wrap break-words text-sm">{a.draft}</p>
    <form action={decideDraft} className="mt-4">
      <input type="hidden" name="id" value={a.id} />
      <details className="mb-3">
        <summary className="cursor-pointer text-sm text-dim underline underline-offset-4">Change the text first</summary>
        <label htmlFor={`draft-${a.id}`} className="sr-only">
          Edited text for draft {a.id}
        </label>
        <textarea
          id={`draft-${a.id}`}
          name="draft"
          rows={6}
          maxLength={5000}
          placeholder="Leave empty to approve the text as written"
          className="mt-2 w-full rounded-lg border border-line bg-ground p-3 text-sm outline-none focus:border-dim"
        />
      </details>
      <div className="grid grid-cols-2 gap-3">
        <button type="submit" name="decision" value="rejected" className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium active:bg-lift">
          No, don&apos;t send
        </button>
        <button type="submit" name="decision" value="approved" className="rounded-lg bg-good px-4 py-2.5 text-sm font-medium text-ground active:opacity-80">
          Yes, send this
        </button>
      </div>
    </form>
  </li>
)

const GoalRow = ({ g, now, tz }: { g: Goal; now: Date; tz: string }) => {
  const { pace } = goalPace(g, now)
  const tone = pace === 'behind' || pace === 'late' ? 'text-late' : pace === 'on pace' || pace === 'met' ? 'text-good' : 'text-faint'
  const pct = Math.max(0, Math.min(100, Math.round((g.current / g.target) * 100)))
  return (
    <li className="rounded-xl border border-line bg-raised p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">{g.title}</p>
        <p className={`shrink-0 text-xs ${tone}`}>{pace}</p>
      </div>
      <p className="mt-1 text-xs text-faint">
        {g.current} of {g.target}
        {g.unit ? ` ${g.unit}` : ''}
        {g.due_at ? ` · by ${fmtDay(g.due_at, tz)}` : ''}
      </p>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-lift" role="img" aria-label={`${pct} percent of the target`}>
        <div className="h-full rounded-full bg-ink" style={{ width: `${pct}%` }} />
      </div>
    </li>
  )
}

const TaskRow = ({ t, tz, late }: { t: Task; tz: string; late: boolean }) => (
  <li className="flex items-baseline justify-between gap-3 border-b border-line py-2.5 last:border-b-0">
    <p className="min-w-0 text-sm">
      {t.title}
      <span className="ml-2 text-xs text-faint">{t.owner === 'assistant' ? 'assistant' : 'you'}</span>
    </p>
    <p className={`shrink-0 text-xs ${late ? 'text-late' : 'text-faint'}`}>{late ? `late · ${fmtWhen(t.due_at, tz)}` : fmtWhen(t.due_at, tz)}</p>
  </li>
)

const AppPage = async ({ searchParams }: { searchParams: Promise<{ e?: string }> }) => {
  const { e } = await searchParams
  const user = await signedIn().catch(() => null)
  if (!user) redirect('/login?next=/app')

  const now = new Date()
  const phoneOn = channelEnv().botUsername !== null
  const [{ agenda, tz }, approved, grants, origin, phone] = await Promise.all([
    loadAgenda(user.sb, 1, now),
    listApprovals(user.sb, 'approved'),
    user.sb.auth.oauth.listGrants().then(
      (r) => (r.error ? [] : (r.data ?? [])),
      () => [],
    ),
    siteOrigin(),
    phoneOn ? phoneLink(user.sb).catch((): PhoneLink | null => null) : Promise.resolve(null),
  ])
  const message = e ? MESSAGES[e] : undefined
  const due = [...agenda.overdue, ...agenda.today]
  const fresh = grants.length === 0

  return (
    <main className="mx-auto max-w-xl px-5 pb-16 pt-8">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">aos</h1>
          <p className="text-xs text-faint">{user.email ?? 'Signed in'}</p>
        </div>
        <form action="/auth/signout" method="post">
          <button type="submit" className="rounded-lg border border-line px-3 py-1.5 text-sm active:bg-lift">
            Sign out
          </button>
        </form>
      </header>

      {message ? (
        <p role="alert" className="mt-6 rounded-lg border border-late/40 bg-late/10 p-3 text-sm text-late">
          {message}
        </p>
      ) : null}

      {fresh ? (
        <Section title="Connect your AI assistant">
          <div className="rounded-xl border border-line bg-raised p-4">
            <p className="mb-3 text-sm text-dim">aos works inside the assistant you already use. Nothing to install.</p>
            <ConnectSteps url={`${origin}/api/mcp`} />
          </div>
        </Section>
      ) : null}

      <Section title="Waiting for your yes" count={agenda.approvals.length}>
        {agenda.approvals.length ? (
          <ul className="space-y-3">
            {agenda.approvals.map((a) => (
              <Draft key={a.id} a={a} tz={tz} />
            ))}
          </ul>
        ) : (
          <Empty text="No drafts. When your assistant wants to send something for you, it shows up here first." />
        )}
      </Section>

      {approved.length ? (
        <Section title="Approved, not sent yet" count={approved.length}>
          <ul className="space-y-2">
            {approved.map((a) => (
              <li key={a.id} className="rounded-xl border border-line bg-raised p-3 text-sm">
                <span className="text-xs text-faint">
                  #{a.id} · {where(a)}
                </span>
                <p className="mt-1 line-clamp-2 text-dim">{a.draft}</p>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-faint">Tell your assistant: &ldquo;send my approved aos drafts&rdquo;.</p>
        </Section>
      ) : null}

      <Section title="Goals" count={agenda.goals.length}>
        {agenda.goals.length ? (
          <ul className="space-y-3">
            {agenda.goals.map((g) => (
              <GoalRow key={g.id} g={g} now={now} tz={tz} />
            ))}
          </ul>
        ) : (
          <Empty text="No goals yet. Tell your assistant something like: set a goal of 10 orders by the 30th." />
        )}
      </Section>

      <Section title="Today" count={due.length}>
        {due.length ? (
          <ul className="rounded-xl border border-line bg-raised px-4">
            {agenda.overdue.map((t) => (
              <TaskRow key={t.id} t={t} tz={tz} late />
            ))}
            {agenda.today.map((t) => (
              <TaskRow key={t.id} t={t} tz={tz} late={false} />
            ))}
          </ul>
        ) : (
          <Empty text="Nothing due today." />
        )}
      </Section>

      {!fresh ? (
        <Section title="Connected apps" count={grants.length}>
          <ul className="space-y-2">
            {grants.map((g) => (
              <li key={g.client.id} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-raised p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm">{g.client.name || 'Unnamed app'}</p>
                  <p className="text-xs text-faint">connected {fmtDay(g.granted_at, tz)}</p>
                </div>
                <form action={disconnectApp}>
                  <input type="hidden" name="client_id" value={g.client.id} />
                  <button type="submit" className="rounded-lg border border-line px-3 py-1.5 text-sm active:bg-lift">
                    Disconnect
                  </button>
                </form>
              </li>
            ))}
          </ul>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-dim underline underline-offset-4">Connect another app</summary>
            <div className="mt-3 rounded-xl border border-line bg-raised p-4">
              <ConnectSteps url={`${origin}/api/mcp`} />
            </div>
          </details>
        </Section>
      ) : null}

      {phoneOn ? (
        <Section title="Your phone">
          {phone ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-raised p-3">
              <div className="min-w-0">
                <p className="truncate text-sm">Telegram{phone.label ? ` · ${phone.label}` : ''}</p>
                <p className="text-xs text-faint">New drafts arrive there with Approve and Reject. Send /today for your day.</p>
              </div>
              <form action={disconnectPhone}>
                <button type="submit" className="rounded-lg border border-line px-3 py-1.5 text-sm active:bg-lift">
                  Unlink
                </button>
              </form>
            </div>
          ) : (
            <div className="rounded-xl border border-line bg-raised p-4">
              <p className="text-sm text-dim">
                Get each draft on your phone and approve it with one tap, even when you are away from your assistant.
              </p>
              <form action={connectTelegram} className="mt-3">
                <button type="submit" className="w-full rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-ground active:opacity-80">
                  Connect Telegram
                </button>
              </form>
              <p className="mt-2 text-xs text-faint">Opens Telegram. Press Start there and you are done. The link works once, for 15 minutes.</p>
            </div>
          )}
        </Section>
      ) : null}

      <Section title="Your time zone">
        <form action={saveTimeZone} className="flex gap-2">
          <label htmlFor="timezone" className="sr-only">
            Time zone
          </label>
          <input
            id="timezone"
            name="timezone"
            defaultValue={tz}
            maxLength={64}
            required
            className="min-w-0 flex-1 rounded-lg border border-line bg-ground px-3 py-2 text-sm outline-none focus:border-dim"
          />
          <button type="submit" className="shrink-0 rounded-lg border border-line px-3 py-2 text-sm active:bg-lift">
            Save
          </button>
        </form>
        <p className="mt-2 text-xs text-faint">&ldquo;Today&rdquo; and repeating tasks follow this zone.</p>
      </Section>
    </main>
  )
}

export default AppPage
