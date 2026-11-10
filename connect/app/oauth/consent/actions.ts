'use server'

import { redirect } from 'next/navigation'
import { isAuthorizationId } from '../../../lib/redirect'
import { signedIn } from '../../../lib/supabase-server'

// The person's answer on the consent screen. Supabase Auth creates the authorization code (or the error) and
// gives back the address of the app that asked; we only pass the person along.
export const decideConnection = async (formData: FormData): Promise<void> => {
  const id = formData.get('authorization_id')
  const allow = formData.get('decision') === 'allow'
  if (!isAuthorizationId(id)) redirect('/app?e=connect')
  const user = await signedIn().catch(() => null)
  if (!user) redirect(`/login?next=${encodeURIComponent(`/oauth/consent?authorization_id=${id}`)}`)
  let target: string | null = null
  try {
    const { data, error } = allow
      ? await user.sb.auth.oauth.approveAuthorization(id)
      : await user.sb.auth.oauth.denyAuthorization(id)
    if (!error && data?.redirect_url) target = data.redirect_url
  } catch {
    target = null
  }
  redirect(target ?? '/app?e=connect')
}
