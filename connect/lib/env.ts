import { z } from 'zod'

const schema = z.object({
  supabaseUrl: z.url(),
  supabaseKey: z.string().min(20),
  siteUrl: z.url().optional(),
})

export interface Env {
  supabaseUrl: string
  supabaseKey: string
  // public origin of this app, no trailing slash; null means "derive it from the request"
  siteUrl: string | null
}

let cached: Env | null = null

// Read lazily so `next build` works without the variables; a request without them fails with a clear message.
export const env = (): Env => {
  if (cached) return cached
  const parsed = schema.safeParse({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL || undefined,
  })
  if (!parsed.success) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set (see .env.example)')
  }
  cached = {
    supabaseUrl: parsed.data.supabaseUrl.replace(/\/+$/, ''),
    supabaseKey: parsed.data.supabaseKey,
    siteUrl: parsed.data.siteUrl ? parsed.data.siteUrl.replace(/\/+$/, '') : null,
  }
  return cached
}

// Supabase Auth is the OAuth authorization server; this is its issuer.
export const authIssuer = (): string => `${env().supabaseUrl}/auth/v1`
