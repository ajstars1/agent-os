import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from './env'

// There is no service-role client anywhere in this app, on purpose. Every query runs with the caller's own token,
// so a bug in our code cannot read another user's rows: Postgres refuses.

// A client that acts as the owner of this access token. Row level security scopes everything it does.
export const userClient = (accessToken: string): SupabaseClient => {
  const { supabaseUrl, supabaseKey } = env()
  return createClient(supabaseUrl, supabaseKey, {
    accessToken: async () => accessToken,
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

let verifier: SupabaseClient | null = null

export interface TokenClaims {
  userId: string
  // set only on tokens issued to a connected app through OAuth (Claude, ChatGPT, any MCP client)
  clientId: string | null
  expiresAt: number | null
}

// Checks the token's signature and expiry against the project's signing keys. Returns null for anything that is
// not a live token of a signed-in user.
export const verifyAccessToken = async (token: string): Promise<TokenClaims | null> => {
  if (!token || token.length > 8192) return null
  if (!verifier) {
    const { supabaseUrl, supabaseKey } = env()
    verifier = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  }
  const { data, error } = await verifier.auth.getClaims(token)
  if (error || !data) return null
  const { claims } = data
  if (typeof claims.sub !== 'string' || !claims.sub || claims.role !== 'authenticated' || claims.is_anonymous === true) return null
  const clientId: unknown = claims.client_id
  return {
    userId: claims.sub,
    clientId: typeof clientId === 'string' && clientId ? clientId : null,
    expiresAt: typeof claims.exp === 'number' ? claims.exp : null,
  }
}
