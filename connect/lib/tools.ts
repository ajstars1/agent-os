// The MCP tools a connected assistant gets. Each call runs as the signed-in user (their token, their rows).
// There is deliberately NO tool to approve a draft: only the person can, on the aos site.
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { formatAgenda, goalLine } from './agenda'
import {
  addEvent,
  addGoal,
  addTask,
  completeTask,
  deleteTask,
  dropGoal,
  getTimeZone,
  listApprovals,
  listGoals,
  listTasks,
  loadAgenda,
  logActivity,
  markApprovalSent,
  recentActivity,
  recordGoalReading,
  requestApproval,
  setProfile,
  updateTask,
  withinRate,
} from './store'
import { userClient } from './supabase'

// Calls per user per minute, across all tools.
export const RATE_LIMIT = 120
export const RATE_WINDOW_S = 60

const ISO = z.string().datetime({ offset: true }).describe('ISO 8601 with offset, e.g. 2026-11-12T10:00:00+05:30')
const AREA = z
  .string()
  .regex(/^[a-z0-9_-]{1,40}$/)
  .describe('Short lowercase label for the part of life or business this belongs to, e.g. sales, shop, family')
const OWNER = z.enum(['me', 'assistant']).describe('"me" = the person does it, "assistant" = you (the AI) do it')
const STATUS = z.enum(['todo', 'doing', 'waiting_approval', 'done', 'skipped'])
const ID = z.number().int().positive()

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const HIDDEN = new Set(['user_id', 'deleted_at'])

export const toText = (data: unknown): string =>
  typeof data === 'string' ? data : JSON.stringify(data, (key, value: unknown) => (HIDDEN.has(key) ? undefined : value), 1)

const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: toText(data) }] })
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true })

// Builds the caller's client from the verified token on the request, applies the rate limit, runs the tool and
// turns any error into a tool error the assistant can read.
export const run =
  <A>(fn: (sb: SupabaseClient, args: A) => Promise<unknown>, client: (token: string) => SupabaseClient = userClient) =>
  async (args: A, ctx: ServerContext): Promise<ToolResult> => {
    const token = ctx.http?.authInfo?.token
    if (!token) return fail('Not signed in')
    try {
      const sb = client(token)
      if (!(await withinRate(sb, 'mcp', RATE_LIMIT, RATE_WINDOW_S))) return fail('Too many requests. Wait a minute and try again.')
      return ok(await fn(sb, args))
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'unknown')
    }
  }

const READ = { readOnlyHint: true }
const WRITE = { readOnlyHint: false, destructiveHint: false }

const taskFields = {
  title: z.string().min(3).max(300),
  area: AREA.optional(),
  owner: OWNER.optional(),
  due_at: ISO.nullable().optional(),
  recur: z.string().max(40).nullable().optional().describe('daily | weekdays | weekly:MO,TH | every:3d (needs due_at)'),
  notes: z.string().max(8000).nullable().optional(),
  goal_id: ID.nullable().optional().describe('The goal this task serves, if any'),
}

export const registerTools = (server: McpServer): void => {
  server.registerTool(
    'agenda',
    {
      title: 'Agenda',
      description:
        "Start here. What is overdue, due today and coming up in the person's own time zone, their calendar, " +
        'drafts waiting for their approval, and how each goal is doing against its date.',
      inputSchema: z.object({ days: z.number().int().min(1).max(31).optional(), include_undated: z.boolean().optional() }),
      annotations: READ,
    },
    run(async (sb, { days, include_undated }: { days?: number; include_undated?: boolean }) => {
      const now = new Date()
      const { agenda, tz } = await loadAgenda(sb, days ?? 1, now)
      return formatAgenda(agenda, now, tz, { undated: include_undated })
    }),
  )

  server.registerTool(
    'task_list',
    {
      title: 'List tasks',
      description: 'List tasks (open ones by default) with filters.',
      inputSchema: z.object({
        status: z.array(STATUS).max(5).optional(),
        owner: OWNER.optional(),
        area: AREA.optional(),
        query: z.string().max(100).optional().describe('Words to find in the title'),
        due_before: ISO.optional(),
        limit: z.number().int().min(1).max(300).optional(),
      }),
      annotations: READ,
    },
    run(async (sb, a: { status?: z.infer<typeof STATUS>[]; owner?: 'me' | 'assistant'; area?: string; query?: string; due_before?: string; limit?: number }) =>
      listTasks(sb, { status: a.status, owner: a.owner, area: a.area, query: a.query, dueBefore: a.due_before, limit: a.limit }),
    ),
  )

  server.registerTool(
    'task_add',
    { title: 'Add task', description: 'Add a task, or a repeating task.', inputSchema: z.object(taskFields), annotations: WRITE },
    run(async (sb, t: z.infer<z.ZodObject<typeof taskFields>>) => addTask(sb, t)),
  )

  server.registerTool(
    'task_update',
    {
      title: 'Update task',
      description: 'Change a task: reschedule, reassign, rename, add notes, or set it to doing. Use task_done to finish one.',
      inputSchema: z.object({ id: ID, status: z.enum(['todo', 'doing']).optional(), ...taskFields, title: taskFields.title.optional() }),
      annotations: WRITE,
    },
    run(async (sb, { id, ...patch }: { id: number; status?: 'todo' | 'doing' } & Partial<z.infer<z.ZodObject<typeof taskFields>>>) =>
      updateTask(sb, id, patch),
    ),
  )

  server.registerTool(
    'task_done',
    {
      title: 'Complete task',
      description: 'Mark a task done (or skipped). A repeating task gets its next occurrence automatically.',
      inputSchema: z.object({ id: ID, note: z.string().max(2000).optional(), skipped: z.boolean().optional() }),
      annotations: WRITE,
    },
    run(async (sb, { id, note, skipped }: { id: number; note?: string; skipped?: boolean }) =>
      completeTask(sb, id, skipped ? 'skipped' : 'done', note),
    ),
  )

  server.registerTool(
    'task_delete',
    {
      title: 'Delete task',
      description: 'Remove a task created by mistake. It is hidden, not erased.',
      inputSchema: z.object({ id: ID }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    run(async (sb, { id }: { id: number }) => deleteTask(sb, id)),
  )

  server.registerTool(
    'approval_request',
    {
      title: 'Ask the person to approve a draft',
      description:
        'Before you send, post or publish ANYTHING on the person\'s behalf (email, message, comment, post), put the exact ' +
        'text here instead of sending it. One call per message. The person approves or rejects it on the aos site; you ' +
        'cannot approve it yourself. Then tell them a draft is waiting.',
      inputSchema: z.object({
        channel: z.string().regex(/^[a-z0-9_-]{1,60}$/).describe('Where it would go, e.g. email, whatsapp, linkedin-post, sms'),
        recipient: z.string().max(200).optional().describe('Who it goes to (name, address or handle)'),
        draft: z.string().min(1).max(5000).describe('The exact text to send, word for word'),
        task_id: ID.optional().describe('The task this draft belongs to; it waits until the person decides'),
        send_after: ISO.optional().describe('Earliest time it may go out'),
      }),
      annotations: WRITE,
    },
    run(async (sb, a: { channel: string; draft: string; recipient?: string; task_id?: number; send_after?: string }) => requestApproval(sb, a)),
  )

  server.registerTool(
    'approval_list',
    {
      title: 'List drafts',
      description:
        'Drafts by status. "approved" = the person said yes: send that text exactly as written, not before its send_after, ' +
        'then call approval_mark_sent. "pending" = still waiting for them.',
      inputSchema: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'sent', 'failed']).optional() }),
      annotations: READ,
    },
    run(async (sb, { status }: { status?: 'pending' | 'approved' | 'rejected' | 'sent' | 'failed' }) => listApprovals(sb, status)),
  )

  server.registerTool(
    'approval_mark_sent',
    {
      title: 'Record that an approved draft went out',
      description:
        'After you sent an approved draft word for word, record it (or record that sending failed). Works only for approved ' +
        'drafts. It is logged in the activity log.',
      inputSchema: z.object({ id: ID, result: z.string().min(1).max(1000).describe('What happened, e.g. "sent from Gmail 10:02"'), failed: z.boolean().optional() }),
      annotations: WRITE,
    },
    run(async (sb, { id, result, failed }: { id: number; result: string; failed?: boolean }) => markApprovalSent(sb, id, result, failed)),
  )

  server.registerTool(
    'activity_log',
    {
      title: 'Log something that happened',
      description: 'Record an event worth remembering: a reply, an order, a call, a meeting, a payment. Who, where, what, result.',
      inputSchema: z.object({
        area: AREA.optional(),
        channel: z.string().min(1).max(60).describe('Where it happened, e.g. email, phone, shop, whatsapp'),
        account: z.string().min(1).max(200).describe('Who it was with (person or company)'),
        action: z.string().min(1).max(500),
        result: z.string().max(1000).optional(),
        task_id: ID.optional(),
      }),
      annotations: WRITE,
    },
    run(async (sb, a: { area?: string; channel: string; account: string; action: string; result?: string; task_id?: number }) => logActivity(sb, a)),
  )

  server.registerTool(
    'activity_recent',
    {
      title: 'Recent activity',
      description: 'The activity log for the last N days.',
      inputSchema: z.object({ area: AREA.optional(), days: z.number().int().min(1).max(90).optional() }),
      annotations: READ,
    },
    run(async (sb, { area, days }: { area?: string; days?: number }) => recentActivity(sb, area, days)),
  )

  server.registerTool(
    'goal_set',
    {
      title: 'Set a goal',
      description: 'A goal is a number and a date, e.g. "10 orders by 15 Nov": title, target, what is counted, and the date.',
      inputSchema: z.object({
        title: z.string().min(3).max(300),
        target: z.number().positive(),
        unit: z.string().max(40).optional().describe('What is counted, e.g. orders, clients, km'),
        due_at: ISO.nullable().optional(),
        area: AREA.optional(),
        current: z.number().optional().describe('Where it stands today (default 0)'),
      }),
      annotations: WRITE,
    },
    run(async (sb, g: { title: string; target: number; unit?: string; due_at?: string | null; area?: string; current?: number }) => addGoal(sb, g)),
  )

  server.registerTool(
    'goal_list',
    {
      title: 'List goals',
      description: 'Goals with their current number and whether each is on pace for its date.',
      inputSchema: z.object({ include_closed: z.boolean().optional() }),
      annotations: READ,
    },
    run(async (sb, { include_closed }: { include_closed?: boolean }) => {
      const now = new Date()
      const [goals, tz] = await Promise.all([listGoals(sb, include_closed), getTimeZone(sb)])
      return goals.length ? goals.map((g) => `${goalLine(g, now, tz)}${g.status !== 'active' ? ` [${g.status}]` : ''}`).join('\n') : 'No goals yet.'
    }),
  )

  server.registerTool(
    'goal_progress',
    {
      title: 'Record goal progress',
      description: 'Set a goal\'s current number (the new total, not the change). Keeps a history; reaching the target marks it met. Or drop a goal.',
      inputSchema: z.object({ id: ID, value: z.number().optional(), note: z.string().max(500).optional(), drop: z.boolean().optional() }),
      annotations: WRITE,
    },
    run(async (sb, { id, value, note, drop }: { id: number; value?: number; note?: string; drop?: boolean }) => {
      if (drop) return dropGoal(sb, id)
      if (value === undefined) throw new Error('Give the new total as value, or drop: true')
      return recordGoalReading(sb, id, value, note)
    }),
  )

  server.registerTool(
    'event_add',
    {
      title: 'Add calendar event',
      description: 'Add a meeting, call or visit to the aos calendar.',
      inputSchema: z.object({
        title: z.string().min(2).max(300),
        starts_at: ISO,
        ends_at: ISO.nullable().optional(),
        area: AREA.optional(),
        location: z.string().max(300).nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
      }),
      annotations: WRITE,
    },
    run(async (sb, e: { title: string; starts_at: string; ends_at?: string | null; area?: string; location?: string | null; notes?: string | null }) => addEvent(sb, e)),
  )

  server.registerTool(
    'settings',
    {
      title: 'Settings',
      description: "Read or set the person's time zone (IANA name, e.g. Asia/Kolkata) and display name. Ask them before changing it.",
      inputSchema: z.object({ timezone: z.string().max(64).optional(), display_name: z.string().max(80).optional() }),
      annotations: WRITE,
    },
    run(async (sb, patch: { timezone?: string; display_name?: string }) =>
      patch.timezone === undefined && patch.display_name === undefined ? { timezone: await getTimeZone(sb) } : setProfile(sb, patch),
    ),
  )
}
