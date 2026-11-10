import { NextResponse, type NextRequest } from 'next/server'
import { handleUpdate } from '../../../lib/bot'
import { claimLink, decideFromChat, snapshot } from '../../../lib/channel-db'
import { channelEnv, env } from '../../../lib/env'
import { sendFromChat } from '../../../lib/sender'
import { callTelegram, clip, sameSecret, sendText, updateSchema } from '../../../lib/telegram'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Telegram posts every message and button press here. Only Telegram knows the webhook secret, so anything without
// it is refused. A valid update always gets 200, even when handling it failed, so Telegram does not resend it.
export const POST = async (req: NextRequest): Promise<NextResponse> => {
  const cfg = channelEnv()
  if (!cfg.botToken || !cfg.webhookSecret || !cfg.secretKey) {
    return NextResponse.json({ error: 'Telegram is not configured' }, { status: 503 })
  }
  if (!sameSecret(req.headers.get('x-telegram-bot-api-secret-token'), cfg.webhookSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const token = cfg.botToken

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ ok: true, ignored: true })

  const siteUrl = env().siteUrl ?? new URL(req.url).origin
  try {
    await handleUpdate(parsed.data, {
      siteUrl,
      now: () => new Date(),
      send: (chatId, text, buttons) => sendText(token, chatId, text, buttons),
      edit: (chatId, messageId, text) => callTelegram(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text: clip(text) }),
      answer: (callbackId, text) => callTelegram(token, 'answerCallbackQuery', { callback_query_id: callbackId, text: clip(text, 190) }),
      claim: claimLink,
      snapshot,
      decide: decideFromChat,
      autoSend: sendFromChat,
    })
  } catch {
    // swallowed on purpose: see above
  }
  return NextResponse.json({ ok: true })
}
