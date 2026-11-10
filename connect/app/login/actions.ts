'use server'

import { redirect } from 'next/navigation'
import { safeNext } from '../../lib/redirect'
import { sessionClient, siteOrigin } from '../../lib/supabase-server'

// Starts Google sign-in. Supabase Auth runs the exchange; we only say where to come back to.
export const signInWithGoogle = async (formData: FormData): Promise<void> => {
  const next = safeNext(formData.get('next'))
  let url: string | null = null
  try {
    const sb = await sessionClient()
    const origin = await siteOrigin()
    const { data, error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}` },
    })
    if (!error && data.url) url = data.url
  } catch {
    url = null
  }
  redirect(url ?? `/login?e=unavailable&next=${encodeURIComponent(next)}`)
}
