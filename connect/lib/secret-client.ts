// The one privileged database client. It may be imported only by lib/channel-db.ts (the Telegram webhook) and
// lib/send-db.ts (sending an approved email). Both expose a few database functions and nothing else.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { channelEnv, env } from './env'

let client: SupabaseClient | null = null

export const secretClient = (): SupabaseClient => {
  if (client) return client
  const { secretKey } = channelEnv()
  if (!secretKey) throw new Error('SUPABASE_SECRET_KEY is not set')
  client = createClient(env().supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return client
}
