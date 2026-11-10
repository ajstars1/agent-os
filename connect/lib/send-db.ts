// Database calls for sending an approved email. They use the secret key, because they are the only readers of a
// sealed mail login. The user id passed in must come from a token this server verified, never from request input.
import { secretClient as db } from './secret-client'
import type { Approval } from './types'

export interface Claim {
  user_id: string
  approval: Approval
  meta: Record<string, unknown>
  ciphertext: string
}

export const claimSend = async (userId: string, id: number): Promise<Claim> => {
  const { data, error } = await db().rpc('send_claim', { p_user: userId, p_id: id })
  if (error) throw new Error(error.message)
  return data as Claim
}

// For a yes that came from the person's linked Telegram chat.
export const claimSendFromChat = async (chatId: string, id: number): Promise<Claim> => {
  const { data, error } = await db().rpc('channel_send_claim', { p_channel: 'telegram', p_external_id: chatId, p_id: id })
  if (error) throw new Error(error.message)
  return data as Claim
}

export const finishSend = async (userId: string, id: number, outcome: 'sent' | 'failed' | 'retry', result: string): Promise<void> => {
  const { error } = await db().rpc('send_finish', { p_user: userId, p_id: id, p_outcome: outcome, p_result: result })
  if (error) throw new Error(error.message)
}
