import { login } from './actions'

export const metadata = { title: 'aos · sign in' }

const MESSAGES: Record<string, string> = {
  bad: 'Wrong passcode.',
  locked: 'Too many tries. Wait 15 minutes.',
  setup: 'AOS_DASHBOARD_PASSCODE is not set on the server (8+ characters).',
  unavailable: 'Sign-in is unavailable right now (database). Try again shortly.',
}

const LoginPage = async ({ searchParams }: { searchParams: Promise<{ e?: string }> }) => {
  const { e } = await searchParams
  const message = e ? MESSAGES[e] : undefined
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-5">
      <h1 className="text-xl font-semibold tracking-tight">aos control</h1>
      <p className="mt-1 text-sm text-zinc-400">Private dashboard</p>
      <form action={login} className="mt-6 space-y-3">
        <label htmlFor="passcode" className="sr-only">
          Passcode
        </label>
        <input
          id="passcode"
          name="passcode"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          placeholder="Passcode"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-3 text-base outline-none focus:border-zinc-400"
        />
        <button
          type="submit"
          className="w-full rounded-lg bg-zinc-100 px-3 py-3 text-base font-medium text-zinc-900 active:bg-zinc-300"
        >
          Sign in
        </button>
        {message ? <p className="text-sm text-red-400">{message}</p> : null}
      </form>
    </main>
  )
}

export default LoginPage
