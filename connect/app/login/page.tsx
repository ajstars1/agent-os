import { redirect } from 'next/navigation'
import { safeNext } from '../../lib/redirect'
import { signedIn } from '../../lib/supabase-server'
import { signInWithGoogle } from './actions'

export const metadata = { title: 'aos · sign in' }

const MESSAGES: Record<string, string> = {
  unavailable: 'Sign-in is not available right now. Try again in a minute.',
  callback: 'That sign-in link did not work or has expired. Try again.',
}

const LoginPage = async ({ searchParams }: { searchParams: Promise<{ e?: string; next?: string }> }) => {
  const { e, next } = await searchParams
  const target = safeNext(next)
  const user = await signedIn().catch(() => null)
  if (user) redirect(target)
  const message = e ? MESSAGES[e] : undefined
  const connecting = target.startsWith('/oauth/consent')
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-5">
      <h1 className="text-2xl font-semibold tracking-tight">aos</h1>
      <p className="mt-2 text-sm text-dim">
        {connecting
          ? 'Sign in first. Then you choose whether your AI assistant may connect.'
          : 'Sign in to see your tasks, goals and the drafts waiting for your yes.'}
      </p>
      <form action={signInWithGoogle} className="mt-8">
        <input type="hidden" name="next" value={target} />
        <button
          type="submit"
          className="w-full rounded-lg bg-ink px-4 py-3 text-base font-medium text-ground active:opacity-80"
        >
          Continue with Google
        </button>
      </form>
      {message ? (
        <p role="alert" className="mt-4 text-sm text-late">
          {message}
        </p>
      ) : null}
      <p className="mt-8 text-xs text-faint">We use your Google account only to know it is you. We never read your mail or files.</p>
    </main>
  )
}

export default LoginPage
