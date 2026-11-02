'use server'

import { cookies } from 'next/headers'
import { z } from 'zod'
import { SESSION_COOKIE, verifySession } from '../../../lib/auth'
import { db } from '../../../lib/db'
import { decideApproval } from '../../../lib/tasks'

export interface DecideResult {
  ok: boolean
  message: string
}

const input = z.object({
  id: z.coerce.number().int().positive(),
  decision: z.enum(['approved', 'rejected']),
})

// Server actions are public POST endpoints: check the session here, not only in middleware.
// decideApproval only touches a draft that is still pending, so a second decision (here or in Discord) fails cleanly.
// No revalidation: the card keeps showing the outcome, and the page catches up on the next visit (saves a render).
export const decideDraft = async (_prev: DecideResult | null, form: FormData): Promise<DecideResult> => {
  const jar = await cookies()
  if (!(await verifySession(jar.get(SESSION_COOKIE)?.value))) {
    return { ok: false, message: 'Your session ended. Sign in again, then retry.' }
  }
  const parsed = input.safeParse({ id: form.get('id'), decision: form.get('decision') })
  if (!parsed.success) return { ok: false, message: 'That request was not valid.' }
  const { id, decision } = parsed.data

  try {
    const { data: current, error } = await db().from('approvals').select('status').eq('id', id).is('deleted_at', null).maybeSingle()
    if (error) throw new Error(error.message)
    if (!current) return { ok: false, message: `Draft #${id} does not exist.` }
    const status = (current as { status: string }).status
    if (status !== 'pending') {
      return { ok: false, message: `Draft #${id} was already ${status === 'rejected' ? 'rejected' : `approved (now ${status})`}, maybe from Discord.` }
    }
    const { sendTask } = await decideApproval(id, decision)
    return decision === 'approved'
      ? {
          ok: true,
          message: `Approved. aos sends it word for word on its next run, usually within 10 minutes${sendTask ? ` (task #${sendTask.id})` : ''}.`,
        }
      : { ok: true, message: 'Rejected. Nothing will be sent.' }
  } catch (err) {
    const text = err instanceof Error ? err.message : ''
    if (/not found|0 rows|no rows|multiple \(or no\) rows|coerce/i.test(text)) {
      return { ok: false, message: 'This draft was already decided, maybe from Discord. Refresh to see where it stands.' }
    }
    return { ok: false, message: 'Could not save the decision. Nothing changed; try again in a minute.' }
  }
}
