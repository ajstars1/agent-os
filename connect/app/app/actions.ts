'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { decideApproval, setProfile } from '../../lib/store'
import { signedIn } from '../../lib/supabase-server'
import { isValidTimeZone } from '../../lib/time'

const decisionSchema = z.object({
  id: z.coerce.number().int().positive(),
  decision: z.enum(['approved', 'rejected']),
  draft: z.string().max(5000).optional(),
})

const back = (code?: string): never => redirect(code ? `/app?e=${code}` : '/app')

// The one place a draft gets approved. It runs with the person's own website session; the database refuses the
// same change from any connected app.
export const decideDraft = async (formData: FormData): Promise<void> => {
  const parsed = decisionSchema.safeParse({
    id: formData.get('id'),
    decision: formData.get('decision'),
    draft: formData.get('draft') ?? undefined,
  })
  if (!parsed.success) back('input')
  const { id, decision, draft } = parsed.data!
  const user = await signedIn().catch(() => null)
  if (!user) redirect('/login?next=/app')
  let failed = false
  try {
    const edited = draft?.trim()
    await decideApproval(user.sb, id, decision, decision === 'approved' && edited ? edited : undefined)
  } catch {
    failed = true
  }
  revalidatePath('/app')
  back(failed ? 'decide' : undefined)
}

const clientSchema = z.object({ client_id: z.string().min(1).max(128) })

// Disconnect an app: its consent, sessions and refresh tokens are revoked by Supabase Auth.
export const disconnectApp = async (formData: FormData): Promise<void> => {
  const parsed = clientSchema.safeParse({ client_id: formData.get('client_id') })
  if (!parsed.success) back('input')
  const user = await signedIn().catch(() => null)
  if (!user) redirect('/login?next=/app')
  let failed = false
  try {
    const { error } = await user.sb.auth.oauth.revokeGrant({ clientId: parsed.data!.client_id })
    failed = Boolean(error)
  } catch {
    failed = true
  }
  revalidatePath('/app')
  back(failed ? 'disconnect' : undefined)
}

const zoneSchema = z.object({ timezone: z.string().min(1).max(64).refine(isValidTimeZone) })

export const saveTimeZone = async (formData: FormData): Promise<void> => {
  const parsed = zoneSchema.safeParse({ timezone: formData.get('timezone') })
  if (!parsed.success) back('zone')
  const user = await signedIn().catch(() => null)
  if (!user) redirect('/login?next=/app')
  let failed = false
  try {
    await setProfile(user.sb, { timezone: parsed.data!.timezone })
  } catch {
    failed = true
  }
  revalidatePath('/app')
  back(failed ? 'zone' : undefined)
}
