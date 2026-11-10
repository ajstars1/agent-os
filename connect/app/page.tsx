import Link from 'next/link'
import { ConnectSteps } from './app/_ui/connect-steps'
import { siteOrigin } from '../lib/supabase-server'

// Rendered per request so the connector link always shows this deployment's own address.
export const dynamic = 'force-dynamic'

const POINTS: { title: string; text: string }[] = [
  {
    title: 'It keeps track',
    text: 'Tasks, repeating jobs and goals with a number and a date. Your assistant tells you what is late and which goal is behind.',
  },
  {
    title: 'Nothing is sent without your yes',
    text: 'Your assistant writes the email or message as a draft. You read it here and press yes or no. It cannot approve its own drafts.',
  },
  {
    title: 'A record of everything',
    text: 'Every draft, every send and every result is logged, so you can always see what was done in your name.',
  },
]

const Home = async () => {
  const origin = await siteOrigin().catch(() => '')
  return (
    <main className="mx-auto max-w-xl px-5 pb-20 pt-14">
      <p className="text-sm font-medium text-dim">aos</p>
      <h1 className="mt-3 text-3xl font-semibold leading-tight tracking-tight">
        Give the AI assistant you already use a to-do list, goals, and a rule: ask before sending.
      </h1>
      <p className="mt-4 text-base text-dim">
        Works inside Claude or ChatGPT on any computer or phone. Nothing to install. You connect it with one link.
      </p>
      <div className="mt-8 flex gap-3">
        <Link href="/login" className="rounded-lg bg-ink px-5 py-3 text-base font-medium text-ground active:opacity-80">
          Start with Google
        </Link>
        <Link href="/app" className="rounded-lg border border-line px-5 py-3 text-base font-medium active:bg-lift">
          Open my aos
        </Link>
      </div>

      <ul className="mt-12 space-y-3">
        {POINTS.map((p) => (
          <li key={p.title} className="rounded-xl border border-line bg-raised p-4">
            <h2 className="text-sm font-medium">{p.title}</h2>
            <p className="mt-1 text-sm text-dim">{p.text}</p>
          </li>
        ))}
      </ul>

      {origin ? (
        <section className="mt-12">
          <h2 className="text-sm font-medium text-dim">Connect it</h2>
          <div className="mt-3 rounded-xl border border-line bg-raised p-4">
            <ConnectSteps url={`${origin}/api/mcp`} />
          </div>
        </section>
      ) : null}
    </main>
  )
}

export default Home
