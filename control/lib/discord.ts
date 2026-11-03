import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LIMIT = 1900
const TIMEOUT_MS = 10_000

// Where a message goes when Discord can't take it. Only the message is written, never the webhook URL.
export const stateDir = (): string => process.env.AOS_STATE_DIR ?? join(homedir(), '.local', 'state', 'aos')
export const fallbackLog = (): string => join(stateDir(), 'notify-fallback.log')

const fallback = (text: string, why: string): void => {
  try {
    mkdirSync(stateDir(), { recursive: true })
    appendFileSync(fallbackLog(), `[${new Date().toISOString()}] (${why})\n${text}\n\n`)
  } catch {
    // read-only filesystem (e.g. Vercel): nothing more we can do
  }
}

export const splitMessage = (text: string, limit = LIMIT): string[] => {
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    const nl = rest.lastIndexOf('\n', limit)
    const cut = nl > 0 ? nl : limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  chunks.push(rest)
  return chunks
}

// Posts to the Discord webhook if one is configured; a missing webhook is not an error.
// Never throws and never puts the webhook URL in an error, log or return value: callers use it inside
// their own catch blocks, so a throw here would hide the original error.
export const notify = async (text: string): Promise<boolean> => {
  const url = process.env.DISCORD_WEBHOOK_URL
  if (!url) return false
  const chunks = splitMessage(text)
  for (let i = 0; i < chunks.length; i++) {
    let status: number | null = null
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: chunks[i], allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.ok) continue
      status = res.status
    } catch {
      // network error, timeout or bad URL; the error text may contain the URL, so it is dropped
    }
    fallback(chunks.slice(i).join(''), status ? `discord HTTP ${status}` : 'discord unreachable')
    return false
  }
  return true
}
