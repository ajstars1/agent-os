import { redirect } from 'next/navigation'
import { isAuthorizationId } from '../../../lib/redirect'
import { signedIn } from '../../../lib/supabase-server'
import { decideConnection } from './actions'

export const metadata = { title: 'aos · connect an app' }

const hostOf = (uri: string): string => {
  try {
    return new URL(uri).host
  } catch {
    return 'an unknown address'
  }
}

const Problem = ({ text }: { text: string }) => (
  <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-5">
    <h1 className="text-xl font-semibold tracking-tight">This connection link did not work</h1>
    <p className="mt-2 text-sm text-dim">{text}</p>
    <a href="/app" className="mt-6 text-sm underline underline-offset-4">
      Go to aos
    </a>
  </main>
)

// Supabase Auth sends the person here when an app (Claude, ChatGPT, any MCP client) asks to connect.
const ConsentPage = async ({ searchParams }: { searchParams: Promise<{ authorization_id?: string }> }) => {
  const { authorization_id: id } = await searchParams
  if (!isAuthorizationId(id)) return <Problem text="Start again from your AI app: add aos as a connector there." />

  const user = await signedIn().catch(() => null)
  if (!user) redirect(`/login?next=${encodeURIComponent(`/oauth/consent?authorization_id=${id}`)}`)

  const { data, error } = await user.sb.auth.oauth.getAuthorizationDetails(id)
  if (error || !data) return <Problem text="The request has expired or was already answered. Start again from your AI app." />
  // already allowed earlier: nothing to ask, go straight back to the app
  if (!('authorization_id' in data)) redirect(data.redirect_url)

  const name = data.client.name || 'An app'
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
      <p className="text-sm text-faint">Signed in as {user.email ?? 'you'}</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Let {name} use your aos?</h1>
      <p className="mt-2 text-sm text-dim">
        It will be sent back to <span className="text-ink">{hostOf(data.redirect_uri)}</span>. Only allow this if you just
        asked to connect aos in that app.
      </p>

      <section className="mt-6 rounded-xl border border-line bg-raised p-4">
        <h2 className="text-sm font-medium">It will be able to</h2>
        <ul className="mt-2 space-y-1.5 text-sm text-dim">
          <li>Read and change your tasks, goals, calendar and activity log</li>
          <li>Write drafts of messages for you to approve</li>
          <li>Mark a draft as sent after you approved it</li>
        </ul>
        <h2 className="mt-4 text-sm font-medium">It will never be able to</h2>
        <ul className="mt-2 space-y-1.5 text-sm text-dim">
          <li>Approve its own drafts. Only you can, here on aos.</li>
          <li>See anyone else&apos;s data, or erase yours for good</li>
        </ul>
      </section>

      <form action={decideConnection} className="mt-6 grid grid-cols-2 gap-3">
        <input type="hidden" name="authorization_id" value={id} />
        <button
          type="submit"
          name="decision"
          value="deny"
          className="rounded-lg border border-line px-4 py-3 text-base font-medium active:bg-lift"
        >
          Don&apos;t allow
        </button>
        <button
          type="submit"
          name="decision"
          value="allow"
          className="rounded-lg bg-ink px-4 py-3 text-base font-medium text-ground active:opacity-80"
        >
          Allow
        </button>
      </form>
      <p className="mt-4 text-xs text-faint">You can disconnect it any time from your aos page.</p>
    </main>
  )
}

export default ConsentPage
