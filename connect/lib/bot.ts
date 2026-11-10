// What the Telegram bot says and does. Pure logic with its effects passed in, so it is tested without Telegram or a
// database. The webhook route wires the real ones.
import { agendaWindow, buildAgenda, formatAgenda } from './agenda'
import type { Snapshot } from './channel-db'
import { SELF_SENT, type SendOutcome } from './sender'
import { draftButtons, draftText, parseButton, parseText, type Button, type Update } from './telegram'
import { DAY_MS, DEFAULT_TZ, isValidTimeZone } from './time'
import type { Approval } from './types'

export interface BotDeps {
  siteUrl: string
  now: () => Date
  send: (chatId: string, text: string, buttons?: Button[][]) => Promise<void>
  edit: (chatId: string, messageId: number, text: string) => Promise<void>
  answer: (callbackId: string, text: string) => Promise<void>
  claim: (chatId: string, code: string, label: string | null) => Promise<boolean>
  snapshot: (chatId: string, from: Date, to: Date) => Promise<Snapshot | null>
  decide: (chatId: string, id: number, decision: 'approved' | 'rejected') => Promise<Approval>
  // sends an approved email with the person's own mail login, when they connected one
  autoSend: (chatId: string, id: number) => Promise<SendOutcome>
}

const MAX_DRAFTS = 10

const notLinked = (site: string): string =>
  `This chat is not linked to aos yet. Open ${site}/app, press "Connect Telegram", then press Start here.`

const HELP =
  'aos on your phone:\n' +
  '/today  what is due, drafts waiting and your goals\n' +
  '/drafts  drafts waiting for your yes, with buttons\n' +
  'yes 12 / no 12  decide draft #12\n\n' +
  'New drafts from your assistant arrive here by themselves.'

// Database errors we raise on purpose are safe to show; anything else becomes a plain retry message.
const SAFE_ERROR = /^(Draft \d+ not found or already decided|Too many messages\. Wait a minute\.|This chat is not linked to aos)$/

const reason = (e: unknown): string => {
  const m = e instanceof Error ? e.message : ''
  return SAFE_ERROR.test(m) ? m : 'Something went wrong. Try again in a minute.'
}

const decidedLine = (a: Pick<Approval, 'id' | 'status'>, sent?: SendOutcome): string => {
  if (a.status !== 'approved') return `❌ Draft #${a.id} rejected. It will not be sent.`
  if (sent?.kind === 'sent') return sent.api ? `✅ Draft #${a.id} approved and run: ${sent.to}.` : `✅ Draft #${a.id} approved and sent to ${sent.to}.`
  if (sent?.kind === 'refused') return `⚠️ Draft #${a.id} approved and run, but ${sent.reason}. It is not retried.`
  if (sent?.kind === 'not_sent') return `✅ Draft #${a.id} approved, but not sent: ${sent.reason}. It is still approved.`
  if (sent?.kind === 'unknown') return `⚠️ Draft #${a.id} approved, but it may not have been sent: ${sent.reason}.`
  return `✅ Draft #${a.id} approved. Your assistant sends it the next time it checks your drafts.`
}

// After a yes: aos sends an email draft itself when it can. Any failure here leaves the draft approved.
const afterYes = async (d: BotDeps, chatId: string, a: Approval): Promise<SendOutcome | undefined> => {
  if (a.status !== 'approved' || !SELF_SENT.has(a.channel)) return undefined
  return d.autoSend(chatId, a.id).catch((): SendOutcome => ({ kind: 'not_sent', reason: 'something went wrong. Try again in a minute' }))
}

const agendaText = (snap: Snapshot, now: Date): string => {
  const tz = snap.timezone && isValidTimeZone(snap.timezone) ? snap.timezone : DEFAULT_TZ
  const w = agendaWindow(now, tz, 1)
  const events = snap.events.filter((e) => {
    const t = new Date(e.starts_at).getTime()
    return t >= w.start.getTime() && t < w.end.getTime()
  })
  const agenda = buildAgenda({ tasks: snap.tasks, approvals: snap.approvals, goals: snap.goals, events }, w)
  return formatAgenda(agenda, now, tz).replace(/\*\*/g, '')
}

const privateChat = (c: { id: number; type: string } | undefined): string | null => (c && c.type === 'private' ? String(c.id) : null)

export const handleUpdate = async (u: Update, d: BotDeps): Promise<void> => {
  if (u.callback_query) {
    const q = u.callback_query
    const chatId = privateChat(q.message?.chat)
    const pick = parseButton(q.data)
    if (!chatId || !pick) {
      await d.answer(q.id, 'That button is no longer valid.')
      return
    }
    try {
      const a = await d.decide(chatId, pick.id, pick.decision)
      await d.answer(q.id, a.status === 'approved' ? 'Approved' : 'Rejected')
      const sent = await afterYes(d, chatId, a)
      if (q.message) await d.edit(chatId, q.message.message_id, `${q.message.text ?? `Draft #${a.id}`}\n\n${decidedLine(a, sent)}`)
    } catch (e) {
      await d.answer(q.id, reason(e))
    }
    return
  }

  const m = u.message
  const chatId = privateChat(m?.chat)
  if (!m || !chatId || !m.text) return
  const cmd = parseText(m.text)

  switch (cmd.kind) {
    case 'link': {
      const label = m.from?.username ? `@${m.from.username}` : (m.from?.first_name ?? null)
      const ok = await d.claim(chatId, cmd.code, label).catch(() => false)
      await d.send(
        chatId,
        ok
          ? `Linked. New drafts from your assistant will arrive here with Approve and Reject buttons.\n\n${HELP}`
          : `That link has expired or was already used. Open ${d.siteUrl}/app and press "Connect Telegram" again.`,
      )
      return
    }
    case 'start':
    case 'help':
      await d.send(chatId, cmd.kind === 'start' ? `${HELP}\n\n${notLinked(d.siteUrl)}` : HELP)
      return
    case 'today':
    case 'drafts': {
      const now = d.now()
      let snap: Snapshot | null
      try {
        snap = await d.snapshot(chatId, new Date(now.getTime() - 2 * DAY_MS), new Date(now.getTime() + 2 * DAY_MS))
      } catch (e) {
        await d.send(chatId, reason(e))
        return
      }
      if (!snap) {
        await d.send(chatId, notLinked(d.siteUrl))
        return
      }
      if (cmd.kind === 'today') {
        await d.send(chatId, agendaText(snap, now))
        return
      }
      if (!snap.approvals.length) {
        await d.send(chatId, 'No drafts waiting.')
        return
      }
      for (const a of snap.approvals.slice(0, MAX_DRAFTS)) await d.send(chatId, draftText(a), draftButtons(a.id))
      if (snap.approvals.length > MAX_DRAFTS) {
        await d.send(chatId, `${snap.approvals.length - MAX_DRAFTS} more waiting. See them all at ${d.siteUrl}/app`)
      }
      return
    }
    case 'decide':
      try {
        const a = await d.decide(chatId, cmd.id, cmd.decision)
        await d.send(chatId, decidedLine(a, await afterYes(d, chatId, a)))
      } catch (e) {
        await d.send(chatId, reason(e))
      }
      return
  }
}
