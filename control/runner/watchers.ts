// Cheap business watchers (no Claude run): every 30 min, ask each venture's own read-only script what is new
// and ping Discord only when something happened. Today: Garh Ka Tailor WhatsApp bot (Firestore).
// LinkedIn replies and ad numbers need a browser, so they stay recurring Claude tasks (reply checks, #19 scoreboard).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EVERY_MS = 30 * 60 * 1000
const STATE = join(import.meta.dir, '.watch-state.json')
const GKT_DIR = '/home/ubuntu/Developer/Ayush/GarhKaTailor/garh-ka-tailor-whatsapp'

type State = { gktSince?: string; lastRun?: number; waitingKey?: string; failedKey?: string }
type GktReport = {
  new_customers: string[]
  new_bookings: string[]
  inbound: number
  failed_sends: string[]
  failed_count: number
  waiting_reply: string[]
}

const load = (): State => (existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as State) : {})

const gkt = (since: string): GktReport => {
  const r = spawnSync('uv', ['run', '-q', '--with', 'google-cloud-firestore', 'python', '-I', 'scripts/watch.py', since],
    { cwd: GKT_DIR, encoding: 'utf8', timeout: 120_000 })
  if (r.status !== 0) throw new Error(`gkt watch failed: ${(r.stderr || '').trim().slice(-200)}`)
  return JSON.parse(r.stdout) as GktReport
}

/** Returns Discord lines to send (empty when nothing new). */
export const runWatchers = (): string[] => {
  const state = load()
  const now = Date.now()
  if (state.lastRun && now - state.lastRun < EVERY_MS) return []
  const since = state.gktSince ?? new Date(now).toISOString() // first run: start watching from now, no backlog
  const lines: string[] = []
  const g = gkt(since)
  if (g.new_bookings.length) lines.push(`🧵 **GKT booking${g.new_bookings.length > 1 ? 's' : ''}**: ${g.new_bookings.join('; ')}`)
  if (g.new_customers.length) lines.push(`🧵 GKT new lead${g.new_customers.length > 1 ? 's' : ''}: ${g.new_customers.join('; ')}`)
  const failedKey = g.failed_sends.join('|')
  if (g.failed_count && failedKey !== state.failedKey) {
    lines.push(`⚠️ GKT: ${g.failed_count} WhatsApp message(s) failed to deliver: ${g.failed_sends.join('; ')}`)
  }
  const waitingKey = g.waiting_reply.join('|')
  if (g.waiting_reply.length && waitingKey !== state.waitingKey) {
    lines.push(`💬 GKT chats waiting for a human reply: ${g.waiting_reply.join(', ')}`)
  }
  writeFileSync(STATE, JSON.stringify({
    gktSince: new Date(now).toISOString(), lastRun: now,
    waitingKey, failedKey: g.failed_count ? failedKey : state.failedKey,
  } satisfies State))
  return lines
}
