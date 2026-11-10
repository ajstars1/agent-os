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

// Server-only settings for the phone channel. Each is optional: without them the bot is simply off.
export interface ChannelEnv {
  // Supabase secret key (sb_secret_...). Used only to call the channel_* database functions; see lib/channel-db.ts.
  secretKey: string | null
  botToken: string | null
  webhookSecret: string | null
  botUsername: string | null
}

const pick = (value: string | undefined, pattern: RegExp): string | null => (value && pattern.test(value) ? value : null)

export const channelEnv = (): ChannelEnv => ({
  secretKey: pick(process.env.SUPABASE_SECRET_KEY, /^\S{20,}$/),
  botToken: pick(process.env.TELEGRAM_BOT_TOKEN, /^\d{5,15}:[A-Za-z0-9_-]{30,}$/),
  webhookSecret: pick(process.env.TELEGRAM_WEBHOOK_SECRET, /^[A-Za-z0-9_-]{32,256}$/),
  botUsername: pick(process.env.NEXT_PUBLIC_TELEGRAM_BOT, /^[A-Za-z0-9_]{5,32}$/),
})
