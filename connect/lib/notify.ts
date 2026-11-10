// Ping the person's linked phone when their assistant queues a draft. Runs with the caller's own client, so it can
// only find the caller's own chat. Never throws: a failed ping must not fail the draft.
import type { SupabaseClient } from '@supabase/supabase-js'
import { channelEnv } from './env'
import { draftButtons, draftText, sendText } from './telegram'
import type { Approval } from './types'

export const notifyDraft = async (sb: SupabaseClient, a: Approval): Promise<boolean> => {
  const { botToken } = channelEnv()
  if (!botToken) return false
  try {
    const { data, error } = await sb
      .from('channel_links')
      .select('external_id')
      .eq('channel', 'telegram')
      .is('deleted_at', null)
      .maybeSingle()
    const chatId = (data as { external_id: string } | null)?.external_id
    if (error || !chatId) return false
    await sendText(botToken, chatId, draftText(a), draftButtons(a.id))
    return true
  } catch {
    return false
  }
}
