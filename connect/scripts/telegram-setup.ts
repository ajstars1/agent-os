// One-time Telegram setup. Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from .env.local (never printed),
// points the bot's webhook at <site>/api/telegram, sets its command menu and prints the bot's username.
//
//   bun scripts/telegram-setup.ts https://aos-connect.vercel.app
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const readEnv = (): Record<string, string> => {
  const out: Record<string, string> = {}
  const text = readFileSync(join(import.meta.dir, '..', '.env.local'), 'utf8')
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

const call = async (token: string, method: string, body: Record<string, unknown> = {}): Promise<unknown> => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string }
  if (!json.ok) throw new Error(`${method}: ${json.description ?? res.status}`)
  return json.result
}

const main = async (): Promise<void> => {
  const site = (process.argv[2] ?? '').replace(/\/+$/, '')
  if (!/^https:\/\/[a-z0-9.-]+$/.test(site)) throw new Error('Pass the public https address, e.g. https://aos-connect.vercel.app')
  const env = readEnv()
  const token = env.TELEGRAM_BOT_TOKEN ?? ''
  const secret = env.TELEGRAM_WEBHOOK_SECRET ?? ''
  if (!/^\d{5,15}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error('TELEGRAM_BOT_TOKEN in .env.local is missing or not a bot token')
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error('TELEGRAM_WEBHOOK_SECRET in .env.local is missing')

  const me = (await call(token, 'getMe')) as { username: string }
  await call(token, 'setWebhook', {
    url: `${site}/api/telegram`,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  })
  await call(token, 'setMyCommands', {
    commands: [
      { command: 'today', description: 'What is due, drafts waiting, goals' },
      { command: 'drafts', description: 'Drafts waiting for your yes' },
    ],
  })
  await call(token, 'setMyDescription', {
    description: 'aos on your phone: approve your assistant\'s drafts with one tap and see your day. Link it from the aos site.',
  })
  process.stdout.write(`${me.username}\n`)
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
