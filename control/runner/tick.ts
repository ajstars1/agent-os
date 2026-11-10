// One scheduler tick (systemd timer, every 10 min):
//  1. pings Discord about overdue tasks owned by people (once per ~20 h each)
//  2. starts Claude Code headless on the oldest due `auto` task owned by claude, unless Claude is at its usage
//     limit (lib/claude-limit.ts); a run that hits the limit goes back in the queue for just after the reset
//  5. every 30 min runs cheap business watchers (runner/watchers.ts)
//  4. once a day copies the newest MeshCentral backup to ~/Backups/aos-mesh (runner/mesh-backup.ts)
//  3. if the home public IP changed, moves the MeshCentral MPS firewall to it (runner/mps-firewall.ts)
// Run from the control/ directory: `bun runner/tick.ts` (Bun loads .env.local).
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db, type Task } from '../lib/db'
import { notify } from '../lib/discord'
import { blockedUntil, fmtTime, parseLimit, readLimit, UNKNOWN_RETRY_MS, writeLimit } from '../lib/claude-limit'
import { closeTask, fmtIst, getTask, sendPrompt } from '../lib/tasks'
import { budgetLimits, checkBudget, WINDOW_MS, type RecentRun } from '../lib/run-budget'
import { approvalIdFromTitle, checkSend, holdReason, recipientKeys, sendAfterOf, touchReason, waitUntil } from '../lib/send-gate'
import { priorTouches, recordTouch } from '../lib/touches'
import { pickNext } from '../lib/task-priority'
import { decideOutcome, isStalled, parseRunResult, STALL_LIMIT } from '../lib/run-result'
import { decideBlock, needsOf, preflight } from './preflight'
import { buildArgs, childEnv, writeMcpConfig } from './spawn'
import type { Approval } from '../lib/db'
import { pullMeshBackup } from './mesh-backup'
import { runWatchers } from './watchers'
import { allowHomeIp } from './mps-firewall'

const LOCK = join(import.meta.dir, '.lock')
const RUN_TIMEOUT_MS = 25 * 60 * 1000
const PING_EVERY_MS = 20 * 60 * 60 * 1000
const DEFAULT_CWD = '/home/ubuntu/Developer/Ayush'
const BUDGET_NOTE = join(import.meta.dir, '.budget-note')
const LAST_IP = join(import.meta.dir, '.home-ip')
const FAILED_IP = join(import.meta.dir, '.home-ip-failed')

const now = (): Date => new Date()

const istHour = (d: Date): number =>
  Number(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }))

const withLock = async (fn: () => Promise<void>): Promise<void> => {
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, 'utf8'))
    try {
      process.kill(pid, 0)
      return // previous tick still running
    } catch {
      unlinkSync(LOCK) // stale
    }
  }
  writeFileSync(LOCK, String(process.pid))
  try {
    await fn()
  } finally {
    unlinkSync(LOCK)
  }
}

const pingPeople = async (): Promise<void> => {
  const h = istHour(now())
  if (h < 8 || h >= 22) return
  const { data, error } = await db()
    .from('tasks')
    .select('*')
    .is('deleted_at', null)
    .eq('status', 'todo')
    .neq('owner', 'claude')
    .lte('due_at', now().toISOString())
    .order('due_at')
  if (error) throw new Error(error.message)
  const cutoff = now().getTime() - PING_EVERY_MS
  const due = (data as Task[]).filter((t) => !t.last_pinged_at || new Date(t.last_pinged_at).getTime() < cutoff)
  if (!due.length) return
  const lines = due.map((t) => `- #${t.id} **${t.owner}**: ${t.title} (due ${fmtIst(t.due_at)})`)
  const sent = await notify(`**Due now, waiting on people**\n${lines.join('\n')}\nReply \`done <id>\` or \`move <id> <when>\`.`)
  if (sent) {
    await db()
      .from('tasks')
      .update({ last_pinged_at: now().toISOString() })
      .in('id', due.map((t) => t.id))
  }
}

interface ClaudeResult {
  result?: string
  session_id?: string
  total_cost_usd?: number
  is_error?: boolean
  subtype?: string // 'success', or 'error_max_turns' / 'error_max_budget_usd' / 'error_during_execution'
}

const runClaude = (task: Task, mcpConfig: string): Promise<{ code: number | null; out: ClaudeResult; timedOut: boolean }> =>
  new Promise((resolve) => {
    const child = spawn('claude', buildArgs(task, mcpConfig), {
      cwd: task.cwd ?? DEFAULT_CWD,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, RUN_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      let out: ClaudeResult = {}
      try {
        out = JSON.parse(stdout) as ClaudeResult
      } catch {
        out = { result: stdout.slice(-1500), is_error: true }
      }
      resolve({ code, out, timedOut })
    })
  })

const blockSend = async (task: Task, approval: Approval, reasons: string[]): Promise<void> => {
  const upd = await db()
    .from('tasks')
    .update({ auto: false, notes: [task.notes, `send gate blocked: ${reasons.join('; ')}`].filter(Boolean).join('\n') })
    .eq('id', task.id)
  if (upd.error) throw new Error(upd.error.message)
  await notify(
    `🛑 Not sending #${task.id} (approval #${approval.id}): ${reasons.join('; ')}.\n` +
      `Fix it with "edit ${approval.id}: <text>" or skip it with "skip ${task.id}".`,
  )
}

const sendGateReasons = async (taskId: number, approval: Approval): Promise<string[]> => {
  const fresh = await getTask(taskId)
  const parentIds = [...new Set([fresh.parent_id, approval.task_id].filter((n): n is number => n !== null && n !== taskId))]
  const parents = await Promise.all(parentIds.map((id) => getTask(id).catch(() => null)))
  const reasons = [...checkSend(approval.channel, approval.recipient, approval.draft).reasons]
  const hold = holdReason([fresh, ...parents.filter((p): p is Task => p !== null)])
  if (hold) reasons.push(hold)
  const keys = recipientKeys(approval.channel, approval.recipient, approval.draft)
  const touch = touchReason(keys, await priorTouches(keys, approval.id))
  if (touch) reasons.push(touch)
  return reasons
}

// Preflight failed: record a zero-cost 'skipped' run (no spawn). The second identical block in a row pauses the task.
const recordBlock = async (task: Task, reason: string): Promise<void> => {
  const prev = await db()
    .from('runs')
    .select('status, summary')
    .eq('task_id', task.id)
    .order('started_at', { ascending: false })
    .limit(1)
  if (prev.error) throw new Error(prev.error.message)
  const last = (prev.data?.[0] ?? null) as { status: string; summary: string | null } | null
  const action = decideBlock(last, reason)
  const ins = await db()
    .from('runs')
    .insert({ task_id: task.id, trigger: 'timer', status: 'skipped', summary: reason, cost_usd: 0, finished_at: now().toISOString() })
  if (ins.error) throw new Error(ins.error.message)
  if (action.kind === 'retry') {
    const upd = await db()
      .from('tasks')
      .update({ due_at: new Date(now().getTime() + action.retryMs).toISOString() })
      .eq('id', task.id)
      .eq('status', 'todo')
    if (upd.error) throw new Error(upd.error.message)
    return
  }
  const upd = await db()
    .from('tasks')
    .update({ auto: false, notes: [task.notes, `${reason} (twice in a row): auto paused ${fmtIst(now().toISOString())}`].filter(Boolean).join('\n') })
    .eq('id', task.id)
  if (upd.error) throw new Error(upd.error.message)
  await notify(`🩺 Paused #${task.id} ${task.title}: ${reason.replace(/^preflight: /, '')} (twice). Fix it, then turn auto back on for #${task.id}.`)
}

// Stall rule (lib/run-result.ts): after a run without a result, look at the task's recent runs. If the last
// STALL_LIMIT spawned runs all ended that way, take the task off auto so it stops costing money. Returns true
// when it paused the task (only a task still in todo and on auto: one Claude closed or parked is left alone).
const pauseIfStalled = async (taskId: number): Promise<boolean> => {
  const recent = await db()
    .from('runs')
    .select('status, summary')
    .eq('task_id', taskId)
    .order('started_at', { ascending: false })
    .limit(STALL_LIMIT * 4)
  if (recent.error) throw new Error(`stall check #${taskId}: ${recent.error.message}`)
  if (!isStalled((recent.data ?? []) as { status: string; summary: string | null }[])) return false
  const fresh = await getTask(taskId)
  if (fresh.status !== 'todo' || !fresh.auto) return false
  const note = `${STALL_LIMIT} runs in a row without a result: auto paused ${fmtIst(now().toISOString())}`
  const upd = await db()
    .from('tasks')
    .update({ auto: false, notes: [fresh.notes, note].filter(Boolean).join('\n') })
    .eq('id', taskId)
    .eq('status', 'todo')
    .select('id')
  if (upd.error) throw new Error(`stall pause #${taskId}: ${upd.error.message}`)
  return (upd.data?.length ?? 0) > 0
}

const runOne = async (): Promise<void> => {
  if (blockedUntil(readLimit())) return // Claude is at its usage limit; due tasks wait for the reset
  const { data, error } = await db()
    .from('tasks')
    .select('*')
    .is('deleted_at', null)
    .eq('status', 'todo')
    .eq('owner', 'claude')
    .eq('auto', true)
    .lte('due_at', now().toISOString())
    .order('due_at')
    .limit(50)
  if (error) throw new Error(error.message)
  const next = pickNext(data as Task[])
  if (!next) return

  // Run budget: pause before Claude's hard limit so Ayush keeps headroom (lib/run-budget.ts).
  const recent = await db()
    .from('runs')
    .select('started_at,cost_usd')
    .gte('started_at', new Date(now().getTime() - WINDOW_MS).toISOString())
  if (recent.error) throw new Error(recent.error.message)
  const budget = checkBudget((recent.data ?? []) as RecentRun[], budgetLimits(), now())
  if (!budget.ok) {
    const until = budget.freeAt ? fmtTime(budget.freeAt) : 'later'
    const note = `${until}`
    if (!existsSync(BUDGET_NOTE) || readFileSync(BUDGET_NOTE, 'utf8') !== note) {
      writeFileSync(BUDGET_NOTE, note)
      await notify(
        `⏸️ Runner paused to leave you Claude headroom: ${budget.runs} runs, $${budget.usd} in the last 5 h. ` +
          `Due tasks (next: #${next.id}) start again around ${until}.`,
      )
    }
    return
  }

  // Pre-send gate: an approved draft is checked with plain rules before Claude may send it.
  const approvalId = approvalIdFromTitle(next.title)
  let approval: Approval | null = null
  if (approvalId !== null) {
    const { data: ap, error: apErr } = await db().from('approvals').select('*').eq('id', approvalId).single()
    if (apErr) throw new Error(apErr.message)
    approval = ap as Approval
    if (approval.status === 'sent') {
      await closeTask(next.id, 'skipped', `runner: approval #${approvalId} is already marked sent`)
      return
    }
    if (approval.status !== 'approved') {
      await blockSend(next, approval, [`approval #${approvalId} is ${approval.status}, not approved`])
      return
    }
    // Scheduled send: too early, so move the task to its time without spawning (no tokens, never early).
    const wait = waitUntil(sendAfterOf(approval), now().getTime())
    if (wait) {
      const upd = await db().from('tasks').update({ due_at: wait.toISOString() }).eq('id', next.id).eq('status', 'todo')
      if (upd.error) throw new Error(upd.error.message)
      return
    }
  }

  // Health preflight: browser and needed logins up, or skip without spawning (no tokens).
  const blocked = await preflight(needsOf(next, approval?.channel), now().getTime())
  if (blocked) {
    await recordBlock(next, blocked)
    return
  }

  // Send gate, right before the spawn: fresh task and parent notes (a hold added after approval wins),
  // the per-recipient touch cap and the plain draft rules.
  if (approval) {
    const reasons = await sendGateReasons(next.id, approval)
    if (reasons.length) {
      await blockSend(next, approval, reasons)
      return
    }
  }

  const mcpConfig = writeMcpConfig()

  // Claim it; another tick or a human may have taken it meanwhile.
  const claimed = await db().from('tasks').update({ status: 'doing' }).eq('id', next.id).eq('status', 'todo').select('id')
  if (claimed.error) throw new Error(`claim #${next.id}: ${claimed.error.message}`)
  if (!claimed.data?.length) return

  const run = await db().from('runs').insert({ task_id: next.id, trigger: 'timer' }).select('id').single()
  const runId = (run.data as { id: number } | null)?.id
  if (run.error || !runId) {
    // never spawn an untracked run: its cost would escape the run budget
    await db().from('tasks').update({ status: 'todo' }).eq('id', next.id).eq('status', 'doing')
    throw new Error(`run insert for #${next.id}: ${run.error?.message ?? 'no id returned'}`)
  }
  // A post's SEND task may come from an older decide path: rebuild its prompt so the post and first comment
  // are split and the header is never posted.
  const task = approval?.channel.toLowerCase() === 'linkedin-post' ? { ...next, prompt: sendPrompt(approval, null) } : next
  const { code, out, timedOut } = await runClaude(task, mcpConfig)
  // a run stopped by --max-turns or --max-budget-usd is a failure, not a quiet success
  const ok = code === 0 && !out.is_error && !timedOut && !(out.subtype ?? '').startsWith('error')
  const summary = (out.result ?? (out.subtype ? `stopped: ${out.subtype}` : '')).trim().slice(0, 3000)

  // A usage limit is not a failure: put the task back for just after the reset and stop starting runs until then.
  const limit = !ok && !timedOut ? parseLimit(summary) : null
  if (limit) {
    const until = limit.until ?? new Date(now().getTime() + UNKNOWN_RETRY_MS)
    writeLimit({ until: limit.until?.toISOString() ?? null, since: now().toISOString(), source: 'runner' })
    if (runId) {
      await db().from('runs')
        .update({ status: 'error', summary: `usage limit, resets ${fmtTime(until)}`, finished_at: now().toISOString() })
        .eq('id', runId)
    }
    await db().from('tasks')
      .update({ status: 'todo', due_at: new Date(until.getTime() + 2 * 60_000).toISOString() })
      .eq('id', next.id).eq('status', 'doing')
    await notify(
      `⏸️ Claude usage limit reached${limit.until ? '' : ' (no reset time given, retrying in 1 h)'}. ` +
        `#${next.id} and the other unattended tasks wait until ${fmtTime(until)}, then start on their own. ` +
        'Meanwhile the bot answers DMs with Gemini and queues real work for then.',
    )
    return
  }

  // Settle the task. Exit 0 alone is not success: the run must call task_done or print an AOS_RESULT line.
  // a task soft-deleted during the run counts as settled
  const after = await getTask(next.id).catch(() => ({ ...next, status: 'skipped' as const }))
  const outcome = decideOutcome({
    exitOk: ok,
    timedOut,
    statusAfter: after.status,
    result: parseRunResult(out.result),
    runId: runId ?? null,
  })

  if (runId) {
    await db()
      .from('runs')
      .update({
        status: outcome.run,
        summary,
        session_id: out.session_id ?? null,
        cost_usd: out.total_cost_usd ?? null,
        finished_at: now().toISOString(),
      })
      .eq('id', runId)
  }

  if (outcome.task.kind === 'done') {
    await closeTask(next.id, 'done', outcome.task.note)
  } else if (outcome.task.kind === 'todo') {
    await db()
      .from('tasks')
      .update({
        status: 'todo',
        due_at: new Date(now().getTime() + outcome.task.retryMs).toISOString(),
        notes: [after.notes, outcome.task.note].filter(Boolean).join('\n'),
      })
      .eq('id', next.id)
      .eq('status', 'doing')
  } else if (outcome.task.kind === 'defer') {
    // Claude put the task back to todo itself; push its due time so the next tick does not run it again.
    // Only ever later: a time Claude set further out stays.
    const retryAt = new Date(now().getTime() + outcome.task.retryMs).toISOString()
    const upd = await db().from('tasks').update({ due_at: retryAt }).eq('id', next.id).eq('status', 'todo').lt('due_at', retryAt)
    if (upd.error) throw new Error(`defer #${next.id}: ${upd.error.message}`)
  }

  // Stall rule: three spawned runs in a row without a result pause the task, whatever the reason.
  const paused = outcome.run === 'ok' ? false : await pauseIfStalled(next.id)

  // Count the touch here too (the MCP's approval_mark_sent also does once deployed; both are idempotent).
  if (approval) {
    const sent = await db().from('approvals').select('*').eq('id', approval.id).single()
    if (!sent.error && (sent.data as Approval).status === 'sent') await recordTouch(sent.data as Approval).catch(() => undefined)
  }

  const icon = { ok: '✅', timeout: '⏱️', error: '⚠️', unverified: '❔', blocked: '🚧' }[outcome.run]
  await notify(`${icon} **#${next.id} ${next.title}** (run ${runId ?? '?'})\n${summary || '(no output)'}`)
  if (paused) {
    await notify(
      `⏸️ Paused #${next.id} ${next.title}: ${STALL_LIMIT} runs in a row ended without a result. ` +
        `Change the task or its brief, then turn auto back on for #${next.id}.`,
    )
  }
}

const checkHomeIp = async (): Promise<void> => {
  const initial = process.env.AOS_HOME_IP
  if (!initial) return
  const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(8000) }).catch(() => null)
  const ip = res?.ok ? (await res.text()).trim() : ''
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return
  const allowed = existsSync(LAST_IP) ? readFileSync(LAST_IP, 'utf8').trim() : initial
  if (ip === allowed) return
  try {
    allowHomeIp(ip)
    writeFileSync(LAST_IP, ip)
    await notify(`🔁 Home IP changed ${allowed} → ${ip}. MPS firewall (Oracle NSG + aos-mesh iptables) updated, AMT reconnects within minutes.`)
  } catch (e) {
    const failed = existsSync(FAILED_IP) ? readFileSync(FAILED_IP, 'utf8').trim() : ''
    if (failed === ip) return // already told Ayush about this IP
    writeFileSync(FAILED_IP, ip)
    await notify(
      `⚠️ Home IP changed ${allowed} → ${ip} but the MPS firewall update failed: ${e instanceof Error ? e.message : 'unknown'}\n` +
        `AMT power-on from outside is down until the 4433 rule allows ${ip}/32 (the Oracle NSG + aos-mesh iptables).`,
    )
  }
}

await withLock(async () => {
  try {
    await checkHomeIp().catch(() => undefined)
    try {
      const backupNote = pullMeshBackup()
      if (backupNote) await notify(backupNote)
    } catch {
      // backup copy is best effort; it retries next tick
    }
    try {
      for (const line of runWatchers()) await notify(line)
    } catch (e) {
      await notify(`⚠️ watcher error: ${e instanceof Error ? e.message : 'unknown'}`)
    }
    await pingPeople()
    await runOne()
  } catch (e) {
    await notify(`⚠️ aos runner error: ${e instanceof Error ? e.message : 'unknown'}`)
    process.exitCode = 1
  }
})
