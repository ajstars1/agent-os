// The bot's only way into the database. It uses the secret key, so it exposes exactly three calls, each a database
// function that finds the user from the linked chat and touches that user's rows only (see the phone migration).
import { secretClient as db } from './secret-client'
import type { Approval, CalendarEvent, Goal, Task } from './types'

const CHANNEL = 'telegram'

export interface Snapshot {
  timezone: string | null
  tasks: Task[]
  approvals: Approval[]
  goals: Goal[]
  events: CalendarEvent[]
}

// Link a chat with a one-time code from /app. False for an unknown, used or expired code.
export const claimLink = async (chatId: string, code: string, label: string | null): Promise<boolean> => {
  const { data, error } = await db().rpc('channel_claim', { p_channel: CHANNEL, p_code: code, p_external_id: chatId, p_label: label })
  if (error) throw new Error(error.message)
  return data === true
}

// Null when the chat is not linked.
export const snapshot = async (chatId: string, from: Date, to: Date): Promise<Snapshot | null> => {
  const { data, error } = await db().rpc('channel_snapshot', { p_channel: CHANNEL, p_external_id: chatId, p_from: from.toISOString(), p_to: to.toISOString() })
  if (error) throw new Error(error.message)
  return (data ?? null) as Snapshot | null
}

export const decideFromChat = async (chatId: string, id: number, decision: 'approved' | 'rejected'): Promise<Approval> => {
  const { data, error } = await db().rpc('channel_decide', { p_channel: CHANNEL, p_external_id: chatId, p_id: id, p_decision: decision })
  if (error) throw new Error(error.message)
  return data as Approval
}
