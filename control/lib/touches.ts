// Per-recipient touch counter (aos v2 Phase 0). A touch is one approved draft that went out; the send gate
// (lib/send-gate.ts) blocks a third touch to the same recipient key.
import { db, type Approval } from './db'
import { recipientKeys } from './send-gate'

// Idempotent: one row per (approval, handle).
export const recordTouch = async (ap: Approval): Promise<void> => {
  const keys = recipientKeys(ap.channel, ap.recipient, ap.draft)
  if (!keys.length) return
  const { error } = await db()
    .from('touches')
    .upsert(
      keys.map((k) => ({ recipient_key: k, channel: ap.channel, approval_id: ap.id, task_id: ap.task_id })),
      { onConflict: 'approval_id,recipient_key', ignoreDuplicates: true },
    )
  if (error) throw new Error(`touches: ${error.message}`)
}

// Distinct approvals already sent to any of these handles, not counting the one about to go out.
export const priorTouches = async (keys: string[], approvalId: number): Promise<number> => {
  if (!keys.length) return 0
  const { data, error } = await db()
    .from('touches')
    .select('approval_id')
    .in('recipient_key', keys)
    .is('deleted_at', null)
    .limit(1000)
  if (error) throw new Error(`touches: ${error.message}`)
  const ids = new Set((data as { approval_id: number | null }[]).map((r) => r.approval_id ?? -1))
  ids.delete(approvalId)
  return ids.size
}
