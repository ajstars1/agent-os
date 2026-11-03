// One-off (idempotent): count every approval already marked sent in the touches table.
// Run from control/: `bun runner/backfill-touches.ts`
import { db, type Approval } from '../lib/db'
import { recordTouch } from '../lib/touches'

const { data, error } = await db().from('approvals').select('*').eq('status', 'sent').is('deleted_at', null).order('id')
if (error) throw new Error(error.message)
for (const ap of data as Approval[]) await recordTouch(ap)
process.stdout.write(`backfilled touches for ${(data as Approval[]).length} sent approvals\n`)
