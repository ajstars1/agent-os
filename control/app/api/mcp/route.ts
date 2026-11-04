import { timingSafeEqual } from 'node:crypto'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { z } from 'zod'
import {
  addEvent,
  addTask,
  agenda,
  closeTask,
  decideApproval,
  deleteTask,
  formatAgenda,
  listApprovals,
  listTasks,
  logActivity,
  markApprovalSent,
  recentActivity,
  requestApproval,
  updateTask,
} from '../../../lib/tasks'
import { db, type Run } from '../../../lib/db'

export const maxDuration = 60

const OWNER = z.enum(['ayush', 'claude', 'shiven', 'mayank', 'family'])
const KIND = z.enum(['task', 'send', 'post', 'check', 'meeting'])
const STATUS = z.enum(['todo', 'doing', 'waiting_approval', 'done', 'skipped'])
const ISO = z.string().datetime({ offset: true }).describe('ISO 8601 with offset, e.g. 2026-10-29T10:00:00+05:30')

const taskFields = {
  title: z.string().min(3).max(300),
  venture: z.string().max(40).optional().describe('0unveiled | dawnwell | gkt | linkedin | general ...'),
  owner: OWNER.optional(),
  kind: KIND.optional(),
  due_at: ISO.nullable().optional(),
  recur: z.string().nullable().optional().describe('daily | weekdays | weekly:MO,TH | every:3d'),
  prompt: z.string().max(8000).nullable().optional().describe('What Claude should do when it runs this task'),
  cwd: z.string().max(300).nullable().optional(),
  source: z.string().max(300).nullable().optional().describe('Plan file/section this came from'),
  notes: z.string().max(4000).nullable().optional(),
  auto: z.boolean().optional().describe('Local runner may start it unattended (owner claude only)'),
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }],
})

const safe =
  <A>(fn: (args: A) => Promise<ToolResult>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args)
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : 'unknown'}` }], isError: true }
    }
  }

const handler = createMcpHandler((server) => {
  server.registerTool(
    'agenda',
    {
      title: 'Agenda',
      description:
        'What is overdue, due today and coming up (IST), plus calendar events and drafts waiting for approval. Start here.',
      inputSchema: z.object({ days: z.number().int().min(1).max(31).optional(), include_undated: z.boolean().optional() }),
    },
    safe(async ({ days, include_undated }) => ok(formatAgenda(await agenda(days ?? 1), { undated: include_undated }))),
  )

  server.registerTool(
    'task_list',
    {
      title: 'List tasks',
      description: 'List tasks (open ones by default) with filters.',
      inputSchema: z.object({
        status: z.array(STATUS).optional(),
        owner: OWNER.optional(),
        venture: z.string().optional(),
        query: z.string().optional(),
        due_before: ISO.optional(),
        limit: z.number().int().min(1).max(300).optional(),
      }),
    },
    safe(async ({ status, owner, venture, query, due_before, limit }) =>
      ok(await listTasks({ status, owner, venture, query, dueBefore: due_before, limit })),
    ),
  )

  server.registerTool(
    'task_add',
    { title: 'Add task', description: 'Add a task or recurring task.', inputSchema: z.object(taskFields) },
    safe(async (t) => ok(await addTask(t))),
  )

  server.registerTool(
    'task_update',
    {
      title: 'Update task',
      description: 'Change any field of a task (reschedule, reassign, edit prompt, set status).',
      inputSchema: z.object({ id: z.number().int(), status: STATUS.optional(), ...taskFields, title: taskFields.title.optional() }),
    },
    safe(async ({ id, ...patch }) => ok(await updateTask(id, patch))),
  )

  server.registerTool(
    'task_done',
    {
      title: 'Complete task',
      description: 'Mark a task done (or skipped). Recurring tasks get their next occurrence created automatically.',
      inputSchema: z.object({ id: z.number().int(), note: z.string().max(2000).optional(), skipped: z.boolean().optional() }),
    },
    safe(async ({ id, note, skipped }) => ok(await closeTask(id, skipped ? 'skipped' : 'done', note))),
  )

  server.registerTool(
    'task_delete',
    { title: 'Delete task', description: 'Soft-delete a task created by mistake.', inputSchema: z.object({ id: z.number().int() }) },
    safe(async ({ id }) => ok(await deleteTask(id))),
  )

  server.registerTool(
    'approval_request',
    {
      title: 'Request approval',
      description:
        'Queue an outbound message (LinkedIn DM, connection note, email, post, comment) for Ayush to approve on Discord. ' +
        'Use this instead of sending. One call per message. If it must go out at a set time (a post slot, an email day), ' +
        'pass send_after: approving it then schedules the send for that time, never earlier. ' +
        'For channel linkedin-post, put the post after a "POST:" line and the first-comment text (links) after a "FIRST COMMENT:" line.',
      inputSchema: z.object({
        task_id: z.number().int().optional(),
        channel: z.string().max(60).describe('e.g. linkedin-dm, linkedin-note, linkedin-post, gmail, zoho, reddit, indiehackers'),
        recipient: z.string().max(200).optional(),
        draft: z.string().min(1).max(5000),
        send_after: ISO.optional().describe('Earliest send time; the approved send waits until then'),
      }),
    },
    safe(async (a) => ok(await requestApproval(a))),
  )

  server.registerTool(
    'approval_list',
    {
      title: 'List approvals',
      description: 'Drafts by status (pending by default).',
      inputSchema: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'sent', 'failed']).optional() }),
    },
    safe(async ({ status }) => ok(await listApprovals(status))),
  )

  server.registerTool(
    'approval_decide',
    {
      title: 'Decide approval',
      description:
        'Record Ayush\'s decision. Only call this when Ayush himself said yes/no in chat or Discord. ' +
        'Approving queues a SEND task that the runner executes.',
      inputSchema: z.object({
        id: z.number().int(),
        decision: z.enum(['approved', 'rejected']),
        edited_draft: z.string().max(5000).optional(),
      }),
    },
    safe(async ({ id, decision, edited_draft }) => ok(await decideApproval(id, decision, edited_draft))),
  )

  server.registerTool(
    'approval_mark_sent',
    {
      title: 'Mark approval sent',
      description: 'After sending an approved draft, record that it went out (or failed).',
      inputSchema: z.object({ id: z.number().int(), result: z.string().max(1000), failed: z.boolean().optional() }),
    },
    safe(async ({ id, result, failed }) => ok(await markApprovalSent(id, result, failed))),
  )

  server.registerTool(
    'log_activity',
    {
      title: 'Log outreach activity',
      description: 'CRM log of a touch: who, channel, what, result. Log every send, reply and accept.',
      inputSchema: z.object({
        venture: z.string().max(40),
        channel: z.string().max(60),
        account: z.string().max(200),
        action: z.string().max(500),
        result: z.string().max(1000).optional(),
        task_id: z.number().int().optional(),
      }),
    },
    safe(async (a) => ok(await logActivity(a))),
  )

  server.registerTool(
    'activity_recent',
    {
      title: 'Recent activity',
      description: 'Outreach log for the last N days.',
      inputSchema: z.object({ venture: z.string().optional(), days: z.number().int().min(1).max(90).optional() }),
    },
    safe(async ({ venture, days }) => ok(await recentActivity(venture, days))),
  )

  server.registerTool(
    'event_add',
    {
      title: 'Add calendar event',
      description: 'Add a meeting, call or visit to the calendar.',
      inputSchema: z.object({
        title: z.string().min(2).max(300),
        venture: z.string().max(40).default('general'),
        starts_at: ISO,
        ends_at: ISO.nullable().default(null),
        location: z.string().max(300).nullable().default(null),
        notes: z.string().max(2000).nullable().default(null),
      }),
    },
    safe(async (e) => ok(await addEvent(e))),
  )

  server.registerTool(
    'runs_recent',
    {
      title: 'Recent Claude runs',
      description: 'What the unattended runner did recently.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    },
    safe(async ({ limit }) => {
      const { data, error } = await db()
        .from('runs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(limit ?? 10)
      if (error) throw new Error(error.message)
      return ok(data as Run[])
    }),
  )
})

const sameToken = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const verifyToken = async (_req: Request, bearer?: string): Promise<AuthInfo | undefined> => {
  const expected = process.env.AOS_MCP_TOKEN
  if (!bearer || !expected || !sameToken(bearer, expected)) return undefined
  return { token: bearer, clientId: 'ayush', scopes: ['aos'] }
}

const authHandler = withMcpAuth(handler, verifyToken, { required: true })

export { authHandler as GET, authHandler as POST, authHandler as DELETE }
