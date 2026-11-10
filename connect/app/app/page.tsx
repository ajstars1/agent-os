import { redirect } from 'next/navigation'
import { goalPace } from '../../lib/agenda'
import { channelEnv } from '../../lib/env'
import { PROVIDERS, unsendable } from '../../lib/mail'
import {
  apiKeys,
  getMaskLevel,
  listApprovals,
  loadAgenda,
  lookupHandle,
  mailConnection,
  phoneLink,
  type ApiKeyInfo,
  type MailConnection,
  type MaskLevel,
  type PhoneLink,
} from '../../lib/store'
import { vaultKey } from '../../lib/vault'
import { signedIn, siteOrigin } from '../../lib/supabase-server'
import { fmtDay, fmtWhen } from '../../lib/time'
import type { Approval, Goal, Task } from '../../lib/types'
import { ConnectSteps } from './_ui/connect-steps'
import {
  connectApiKey,
  connectEmail,
  connectTelegram,
  decideDraft,
  disconnectApiKey,
  disconnectApp,
  disconnectEmail,
  disconnectPhone,
  savePrivacy,
  saveTimeZone,
  sendNow,
} from './actions'

export const metadata = { title: 'aos · today', robots: { index: false, follow: false } }
export const dynamic = 'force-dynamic'

const MESSAGES: Record<string, string> = {
  input: 'That did not go through. Try again.',
  decide: 'Could not save your decision. The draft may already be decided. Reload and check.',
  disconnect: 'Could not disconnect that app. Try again.',
  zone: 'That time zone is not known. Use a name like Asia/Kolkata or Europe/London.',
  connect: 'The connection request did not work. Start again from your AI app.',
  phone: 'Could not connect or disconnect your phone. Try again in a minute.',
  mail_off: 'Email sending is not switched on for this site yet.',
  mail_input: 'Check the email address and the app password, then try again.',
  mail_rate: 'Too many tries. Wait an hour, then connect your email again.',
  mail_login: 'Your mail provider refused that login. Use an app password (not your normal password) and pick the right provider.',
  mail_save: 'Could not save that. Try again in a minute.',
  send: 'Approved, but aos could not send it. It is still approved: try Send now, or ask your assistant to send it.',
  send_login: 'Approved, but your mail provider refused the saved login. Reconnect your email below, then press Send now.',
  send_shape: 'Approved, but aos cannot send this one itself: it needs exactly one email address and a subject. Your assistant can still send it.',
  send_limit: 'Approved, but the limit of 50 emails a day is reached. Send it tomorrow.',
  send_unknown: 'The connection broke while sending. Check your Sent folder, or the service, before trying again.',
  send_refused: 'Approved and run, but the service refused the request. The answer is shown with the draft; it is not retried.',
  key_input: 'Check the key details: a short name (letters, digits, - or _), the service address such as api.example.com, and the key itself.',
  key_save: 'Could not save or remove that key. Try again in a minute.',
  privacy: 'Could not save the privacy setting. Try again in a minute.',
}

const NOTICES: Record<string, string> = {
  sent: 'Sent from your mailbox.',
  mail: 'Email connected. Approved emails now go out from your own mailbox.',
  ran: 'Done. The request ran with your saved key.',
  key: 'Key saved. Your assistant can now use it by name, without seeing it.',
  privacy: 'Privacy setting saved.',
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

// True when pressing yes makes aos send this draft itself, right away.
const sendsOnYes = (a: Approval, mail: MailConnection | null): boolean => {
  if (a.send_after && new Date(a.send_after).getTime() > Date.now()) return false
  if (a.channel === 'api') return true
  return mail !== null && a.channel === 'email' && unsendable(a) === null
}

const yesHint = (a: Approval, mail: MailConnection | null): string =>
  a.channel === 'api'
    ? 'Yes runs this request now with your saved key.'
    : sendsOnYes(a, mail)
      ? `Yes sends it now from ${mail?.username}.`
      : 'Yes approves it. Your assistant sends it the next time you talk to it.'

const yesLabel = (a: Approval, mail: MailConnection | null): string =>
  a.channel === 'api' ? 'Yes, run it now' : sendsOnYes(a, mail) ? 'Yes, send now' : 'Yes, approve'

const LEVELS: { id: MaskLevel; label: string }[] = [
  { id: 'api', label: 'Hide email addresses and phone numbers that come from my connected services (recommended)' },
  { id: 'all', label: 'Also hide them in my own tasks, drafts and log' },
  { id: 'off', label: 'Show everything to my assistant' },
]

const Draft = ({ a, tz, mail }: { a: Approval; tz: string; mail: MailConnection | null }) => (
  <li className="rounded-xl border border-line bg-raised p-4">
    <p className="text-xs text-faint">
      #{a.id} · {where(a)}
      {a.send_after ? ` · goes out no earlier than ${fmtWhen(a.send_after, tz)}` : ''}
    </p>
    {a.subject ? <p className="mt-2 break-words text-sm font-medium">{a.subject}</p> : null}
    <p className="mt-2 whitespace-pre-wrap break-words text-sm">{a.draft}</p>
    <p className="mt-3 text-xs text-faint">{yesHint(a, mail)}</p>
    <form action={decideDraft} className="mt-4">
      <input type="hidden" name="id" value={a.id} />
      <details className="mb-3" hidden={a.channel === 'api'}>
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
          {yesLabel(a, mail)}
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

const AppPage = async ({ searchParams }: { searchParams: Promise<{ e?: string; n?: string; who?: string }> }) => {
  const { e, n, who } = await searchParams
  const user = await signedIn().catch(() => null)
  if (!user) redirect('/login?next=/app')

  const now = new Date()
  const phoneOn = channelEnv().botUsername !== null
  const mailOn = vaultKey() !== null && channelEnv().secretKey !== null
  // "EMAIL_12", "[phone_3]" ... typed into the look-up box
  const asked = /^\[?(EMAIL|PHONE)_(\d{1,9})\]?$/i.exec((who ?? '').trim())
  const [{ agenda, tz }, approved, grants, origin, phone, mail, keys, level, askedValue] = await Promise.all([
    loadAgenda(user.sb, 1, now),
    listApprovals(user.sb, 'approved'),
    user.sb.auth.oauth.listGrants().then(
      (r) => (r.error ? [] : (r.data ?? [])),
      () => [],
    ),
    siteOrigin(),
    phoneOn ? phoneLink(user.sb).catch((): PhoneLink | null => null) : Promise.resolve(null),
    mailOn ? mailConnection(user.sb).catch((): MailConnection | null => null) : Promise.resolve(null),
    mailOn ? apiKeys(user.sb).catch((): ApiKeyInfo[] => []) : Promise.resolve([]),
    mailOn ? getMaskLevel(user.sb).catch((): MaskLevel => 'api') : Promise.resolve<MaskLevel>('api'),
    mailOn && asked
      ? lookupHandle(user.sb, asked[1].toLowerCase() === 'email' ? 'email' : 'phone', Number(asked[2])).catch(() => null)
      : Promise.resolve(null),
  ])
  const message = e ? MESSAGES[e] : undefined
  const notice = n ? NOTICES[n] : undefined
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

      {notice ? (
        <p role="status" className="mt-6 rounded-lg border border-good/40 bg-good/10 p-3 text-sm text-good">
          {notice}
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
              <Draft key={a.id} a={a} tz={tz} mail={mail} />
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
                {a.result ? <p className="mt-1 text-xs text-late">{a.result}</p> : null}
                {sendsOnYes(a, mail) ? (
                  <form action={sendNow} className="mt-2">
                    <input type="hidden" name="id" value={a.id} />
                    <button type="submit" className="rounded-lg border border-line px-3 py-1.5 text-sm active:bg-lift">
                      Send now
                    </button>
                  </form>
                ) : null}
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

      {mailOn ? (
        <Section title="Email sending">
          {mail ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-raised p-3">
              <div className="min-w-0">
                <p className="truncate text-sm">{mail.username}</p>
                <p className="text-xs text-faint">
                  Emails you approve go out from this mailbox. Your assistant never sees the password; it is stored sealed.
                </p>
              </div>
              <form action={disconnectEmail}>
                <button type="submit" className="rounded-lg border border-line px-3 py-1.5 text-sm active:bg-lift">
                  Remove
                </button>
              </form>
            </div>
          ) : (
            <form action={connectEmail} className="space-y-3 rounded-xl border border-line bg-raised p-4" autoComplete="off">
              <p className="text-sm text-dim">
                Let aos send the emails you approve, from your own mailbox, even when your assistant is closed. Your assistant
                never sees this password.
              </p>
              <div>
                <label htmlFor="mail-provider" className="text-xs text-faint">
                  Mail provider
                </label>
                <select id="mail-provider" name="provider" required className="mt-1 w-full rounded-lg border border-line bg-ground px-3 py-2 text-sm outline-none focus:border-dim">
                  {Object.entries(PROVIDERS).map(([id, p]) => (
                    <option key={id} value={id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="mail-username" className="text-xs text-faint">
                  Your email address
                </label>
                <input id="mail-username" name="username" type="email" required maxLength={254} autoComplete="off" className="mt-1 w-full rounded-lg border border-line bg-ground px-3 py-2 text-sm outline-none focus:border-dim" />
              </div>
              <div>
                <label htmlFor="mail-password" className="text-xs text-faint">
                  App password
                </label>
                <input id="mail-password" name="password" type="password" required minLength={4} maxLength={200} autoComplete="new-password" className="mt-1 w-full rounded-lg border border-line bg-ground px-3 py-2 text-sm outline-none focus:border-dim" />
                <p className="mt-1 text-xs text-faint">
                  Not your normal password. Make an app password at your provider: for Gmail, Google Account → Security → 2-Step
                  Verification → App passwords; for Zoho, Accounts → Security → App Passwords.
                </p>
              </div>
              <div>
                <label htmlFor="mail-from" className="text-xs text-faint">
                  Name shown to recipients (optional)
                </label>
                <input id="mail-from" name="from_name" maxLength={80} autoComplete="off" className="mt-1 w-full rounded-lg border border-line bg-ground px-3 py-2 text-sm outline-none focus:border-dim" />
              </div>
              <button type="submit" className="w-full rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-ground active:opacity-80">
                Check and connect
              </button>
            </form>
          )}
        </Section>
      ) : null}

      {mailOn ? (
        <Section title="Connected services" count={keys.length}>
          {keys.length ? (
            <ul className="mb-3 space-y-2">
              {keys.map((k) => (
                <li key={k.name} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-raised p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      {k.name} <span className="text-faint">· {k.host}</span>
                    </p>
                    <p className="text-xs text-faint">{k.writes === 'ask' ? 'Can read. Changes wait for your yes.' : 'Can read only.'}</p>
                  </div>
                  <form action={disconnectApiKey}>
                    <input type="hidden" name="name" value={k.name} />
                    <button type="submit" className="rounded-lg border border-line px-3 py-1.5 text-sm active:bg-lift">
                      Remove
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          ) : null}
          <details className="rounded-xl border border-line bg-raised p-4" open={keys.length === 0}>
            <summary className="cursor-pointer text-sm text-dim">Add a service key</summary>
            <form action={connectApiKey} className="mt-3 space-y-3" autoComplete="off">
              <p className="text-sm text-dim">
                Let your assistant use a service for you (payments, shop, CRM) without ever seeing the key. The key can only be
                sent to the address you enter here.
              </p>
              <div>
                <label htmlFor="key-name" className="text-xs text-faint">
                  Short name your assistant will use
                </label>
                <input id="key-name" name="name" required pattern="[a-z0-9_\-]{1,40}" maxLength={40} placeholder="razorpay" autoComplete="off" className="mt-1 w-full rounded-lg border border-line bg-ground px-3 py-2 text-sm outline-none focus:border-dim" />
              </div>
              <div>
                <label htmlFor="key-host" className="text-xs text-faint">
                  Service address
                </label>
                <input id="key-host" name="host" required maxLength={300} placeholder="api.razorpay.com" autoComplete="off" className="mt-1 w-full rounded-lg border border-line bg-ground px-3 py-2 text-sm outline-none focus:border-dim" />
              </div>
              <div>
                <label htmlFor="key-scheme" className="text-xs text-faint">
                  How the service wants the key
                </label>
                <select id="key-scheme" name="scheme" required className="mt-1 w-full rounded-lg border border-line bg-ground px-3 py-2 text-sm outline-none focus:border-dim">
                  <option value="bearer">Bearer token (most services)</option>
                  <option value="basic">Basic: key id and secret, written as id:secret</option>
                  <option value="header">A header of its own (name it below)</option>
                </select>
              </div>
              <div>
                <label htmlFor="key-header" className="text-xs text-faint">
                  Header name (only for the last choice), e.g. X-API-Key
                </label>
                <input id="key-header" name="header" maxLength={64} autoComplete="off" className="mt-1 w-full rounded-lg border border-line bg-ground px-3 py-2 text-sm outline-none focus:border-dim" />
              </div>
              <div>
                <label htmlFor="key-value" className="text-xs text-faint">
                  The key
                </label>
                <input id="key-value" name="key" type="password" required minLength={8} maxLength={2000} autoComplete="new-password" className="mt-1 w-full rounded-lg border border-line bg-ground px-3 py-2 text-sm outline-none focus:border-dim" />
              </div>
              <label className="flex items-start gap-2 text-sm text-dim">
                <input type="checkbox" name="writes" value="ask" className="mt-1" />
                <span>Allow requests that change something. Each one waits for my yes first.</span>
              </label>
              <button type="submit" className="w-full rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-ground active:opacity-80">
                Save key
              </button>
            </form>
          </details>
        </Section>
      ) : null}

      {mailOn ? (
        <Section title="Privacy">
          <form action={savePrivacy} className="space-y-2 rounded-xl border border-line bg-raised p-4">
            {LEVELS.map((l) => (
              <label key={l.id} className="flex items-start gap-2 text-sm">
                <input type="radio" name="level" value={l.id} defaultChecked={level === l.id} className="mt-1" />
                <span>{l.label}</span>
              </label>
            ))}
            <p className="text-xs text-faint">
              A hidden value reaches your assistant as a stand-in such as [EMAIL_12]. It can still use it; aos puts the real value
              in when it sends. You always see real values here and on your phone.
            </p>
            <button type="submit" className="rounded-lg border border-line px-3 py-1.5 text-sm active:bg-lift">
              Save
            </button>
          </form>
          <form method="get" action="/app" className="mt-3 flex gap-2">
            <label htmlFor="who" className="sr-only">
              Stand-in to look up
            </label>
            <input id="who" name="who" defaultValue={asked ? `${asked[1].toUpperCase()}_${asked[2]}` : ''} maxLength={20} placeholder="EMAIL_12" className="min-w-0 flex-1 rounded-lg border border-line bg-ground px-3 py-2 text-sm outline-none focus:border-dim" />
            <button type="submit" className="shrink-0 rounded-lg border border-line px-3 py-2 text-sm active:bg-lift">
              Who is this?
            </button>
          </form>
          {asked ? (
            <p role="status" className="mt-2 break-words text-sm">
              {askedValue ? `${asked[1].toUpperCase()}_${asked[2]} is ${askedValue}` : `No ${asked[1].toUpperCase()}_${asked[2]} on your account.`}
            </p>
          ) : null}
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
