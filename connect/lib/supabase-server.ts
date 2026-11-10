import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { cookies, headers } from 'next/headers'
import { env } from './env'

// The signed-in person's client for pages and server actions: their session lives in httpOnly cookies and every
// query runs with their own token, so row level security applies here exactly as it does for a connected app.
export const sessionClient = async (): Promise<SupabaseClient> => {
  const store = await cookies()
  const { supabaseUrl, supabaseKey } = env()
  return createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options)
        } catch {
          // a Server Component cannot set cookies; the middleware refreshes the session instead
        }
      },
    },
  })
}

export interface SignedIn {
  sb: SupabaseClient
  userId: string
  email: string | null
}

// Null when nobody is signed in. Verifies the session token; never trusts the cookie as is.
export const signedIn = async (): Promise<SignedIn | null> => {
  const sb = await sessionClient()
  const { data, error } = await sb.auth.getClaims()
  const claims = data?.claims
  if (error || !claims || typeof claims.sub !== 'string' || claims.is_anonymous === true) return null
  return { sb, userId: claims.sub, email: typeof claims.email === 'string' ? claims.email : null }
}

// Public origin of this app: the configured one, else what the proxy says.
export const siteOrigin = async (): Promise<string> => {
  const configured = env().siteUrl
  if (configured) return configured
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}
