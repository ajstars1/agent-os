// Telegram Bot API: sending, and reading what Telegram posts to our webhook. Plain text only (no parse mode), so a
// draft's text can never be read as formatting or links we did not write.
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { Approval } from './types'

export interface Button {
  text: string
  callback_data: string
}

const LIMIT = 4000

export const clip = (text: string, max = LIMIT): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export const callTelegram = async (token: string, method: string, body: Record<string, unknown>): Promise<void> => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`Telegram ${method} failed with ${res.status}`)
}

export const sendText = (token: string, chatId: string, text: string, buttons?: Button[][]): Promise<void> =>
  callTelegram(token, 'sendMessage', {
    chat_id: chatId,
    text: clip(text),
    link_preview_options: { is_disabled: true },
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  })

export const draftButtons = (id: number): Button[][] => [
  [
    { text: '✅ Approve', callback_data: `a:${id}` },
    { text: '❌ Reject', callback_data: `r:${id}` },
  ],
]

export const draftText = (a: Pick<Approval, 'id' | 'channel' | 'recipient' | 'draft'> & { subject?: string | null }): string =>
  `Draft #${a.id} · ${a.channel}${a.recipient ? ` to ${a.recipient}` : ''}${a.subject ? `\nSubject: ${a.subject}` : ''}\n\n${clip(a.draft, 3500)}`

// Constant-time check of the secret Telegram sends back with every update.
export const sameSecret = (given: string | null, expected: string): boolean => {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const chat = z.object({ id: z.number().int(), type: z.string() })

export const updateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      chat,
      from: z.object({ first_name: z.string().max(200).optional(), username: z.string().max(64).optional() }).optional(),
      text: z.string().max(4096).optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string().max(100),
      data: z.string().max(64).optional(),
      message: z.object({ message_id: z.number().int(), chat, text: z.string().max(4096).optional() }).optional(),
    })
    .optional(),
})

export type Update = z.infer<typeof updateSchema>

export type Command =
  | { kind: 'link'; code: string }
  | { kind: 'start' }
  | { kind: 'today' }
  | { kind: 'drafts' }
  | { kind: 'decide'; id: number; decision: 'approved' | 'rejected' }
  | { kind: 'help' }

const YES = new Set(['yes', 'y', 'approve', 'ok'])
const NO = new Set(['no', 'n', 'reject'])

export const parseText = (text: string): Command => {
  const t = text.trim()
  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/i.exec(t)
  if (start) return start[1] ? { kind: 'link', code: start[1] } : { kind: 'start' }
  if (/^\/?today(?:@\w+)?$/i.test(t)) return { kind: 'today' }
  if (/^\/?drafts(?:@\w+)?$/i.test(t)) return { kind: 'drafts' }
  const yn = /^([a-z]+)\s*#?(\d{1,12})$/i.exec(t)
  if (yn) {
    const word = yn[1].toLowerCase()
    const id = Number(yn[2])
    if (YES.has(word)) return { kind: 'decide', id, decision: 'approved' }
    if (NO.has(word)) return { kind: 'decide', id, decision: 'rejected' }
  }
  return { kind: 'help' }
}

export const parseButton = (data: string | undefined): { id: number; decision: 'approved' | 'rejected' } | null => {
  const m = data ? /^([ar]):(\d{1,12})$/.exec(data) : null
  return m ? { id: Number(m[2]), decision: m[1] === 'a' ? 'approved' : 'rejected' } : null
}
