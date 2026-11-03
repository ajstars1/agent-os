// One scheduler tick (systemd timer, every 10 min):
//  1. pings Discord about overdue tasks owned by people (once per ~20 h each)
//  2. starts Claude Code headless on the oldest due `auto` task owned by claude, unless Claude is at its usage
//     limit (lib/claude-limit.ts); a run that hits the limit goes back in the queue for just after the reset
//  5. every 30 min runs cheap business watchers (runner/watchers.ts)
//  4. once a day copies the newest MeshCentral backup to ~/Backups/aos-mesh (runner/mesh-backup.ts)
//  3. if the home public IP changed, moves the MeshCentral MPS firewall to it (runner/mps-firewall.ts)
// Run from the control/ directory: `bun runner/tick.ts` (Bun loads .env.local).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db, type Task } from '../lib/db'
import { notify } from '../lib/discord'
import { blockedUntil, fmtTime, parseLimit, readLimit, UNKNOWN_RETRY_MS, writeLimit } from '../lib/claude-limit'
import { closeTask, fmtIst, getTask } from '../lib/tasks'
import { budgetLimits, checkBudget, WINDOW_MS, type RecentRun } from '../lib/run-budget'
import { approvalIdFromTitle, checkSend } from '../lib/send-gate'
import { pickNext } from '../lib/task-priority'
import { decideOutcome, parseRunResult } from '../lib/run-result'
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

const RULES = `You are running unattended, started by the aos runner for one task. Ayush is not watching.
Rules, in priority order:
1. Never send, post, comment, connect, email or message anyone yourself. For every outbound item, call approval_request (aos MCP) with the exact text, the channel and the recipient. Ayush approves on Discord, and an approved draft comes back to you as its own task.
   Exception: if your task title starts with "SEND APPROVED #", send exactly that approved text, nothing else, then call approval_mark_sent and log_activity.
2. Never buy anything, delete anything, change account settings, accept terms or enter credentials. If login, a CAPTCHA or a payment is needed, stop and say so.
3. Read and follow CLAUDE.md, notes/outreach-playbook.md and the plan file named in the task before acting. No em dashes in any copy.
4. Read-only checks (inboxes, Ads Manager, dashboards) are fine. Log what you find in the plan file the task names, and call log_activity for every reply or accept.
5. Browser: Claude in Chrome, in a new tab you close when done. "Disconnected" means Chrome is closed: run \`bash ~/Developer/Ayush/agent-os/control/hooks/ensure-chrome.sh\`, then retry twice. For sites the extension can't use (reddit.com), pilot-browser with mode "managed", profile "aos" works unattended; never mode "attach" here (it needs a person to click Allow). A site not logged in there: skip and say so.
6. When finished, call task_done with the task id and a one-line note. If blocked, call task_update with status "todo" and the reason in notes.
7. End with a plain summary of 8 lines or fewer: what you did, what needs Ayush.
8. The very last line of your reply must be exactly one result line, JSON on one line:
AOS_RESULT {"status":"done","summary":"<one line>"}
status is "done" only if the task's goal was met, "blocked" if you could not proceed (login, CAPTCHA, missing input), "failed" otherwise. Without this line (or task_done) the run counts as unverified and the task is retried.`

const now = (): Date => new Date()

// Coordinator mode (on in Ayush's user settings) turns a run into a fan-out of subagents. Runner sessions do one
// task, so it is off: dropped from the child env and overridden in flag settings, which outrank user settings.
const NO_COORDINATOR_SETTINGS = JSON.stringify({ env: { CLAUDE_CODE_COORDINATOR_MODE: '0' } })
const childEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  delete env.CLAUDE_CODE_COORDINATOR_MODE
  return env
}

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
}

const runClaude = (task: Task): Promise<{ code: number | null; out: ClaudeResult; timedOut: boolean }> =>
  new Promise((resolve) => {
    const prompt =
      `aos task #${task.id}: ${task.title}\nVenture: ${task.venture}. Kind: ${task.kind}.` +
      (task.source ? `\nPlan file: ${task.source}` : '') +
      (task.notes ? `\nNotes so far:\n${task.notes}` : '') +
      `\n\nInstructions:\n${task.prompt ?? task.title}`
    const child = spawn(
      'claude',
      // unattended runs never drive the desktop: Ayush may be using it
      [
        '-p', prompt, '--permission-mode', 'auto', '--output-format', 'json', '--chrome', '--disallowedTools', 'mcp__desk',
        '--settings', NO_COORDINATOR_SETTINGS, '--append-system-prompt', RULES,
      ],
      { cwd: task.cwd ?? DEFAULT_CWD, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
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

// Tasks may need Claude in Chrome; after an unattended boot Chrome is not running yet.
const ensureChrome = async (): Promise<void> => {
  if (spawnSync('pgrep', ['-x', 'chrome']).status === 0) return
  spawnSync('hyprctl', ['dispatch', 'exec', 'google-chrome-stable'])
  await new Promise((r) => setTimeout(r, 10_000))
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
  if (approvalId !== null) {
    const { data: ap, error: apErr } = await db().from('approvals').select('*').eq('id', approvalId).single()
    if (apErr) throw new Error(apErr.message)
    const approval = ap as Approval
    if (approval.status === 'sent') {
      await closeTask(next.id, 'skipped', `runner: approval #${approvalId} is already marked sent`)
      return
    }
    const reasons =
      approval.status !== 'approved'
        ? [`approval #${approvalId} is ${approval.status}, not approved`]
        : checkSend(approval.channel, approval.recipient, approval.draft).reasons
    if (reasons.length) {
      await db()
        .from('tasks')
        .update({
          auto: false,
          notes: [next.notes, `send gate blocked: ${reasons.join('; ')}`].filter(Boolean).join('\n'),
        })
        .eq('id', next.id)
      await notify(
        `🛑 Not sending #${next.id} (approval #${approvalId}): ${reasons.join('; ')}.\n` +
          `Fix it with "edit ${approvalId}: <text>" or skip it with "skip ${next.id}".`,
      )
      return
    }
  }

  // Claim it; another tick or a human may have taken it meanwhile.
  const claimed = await db().from('tasks').update({ status: 'doing' }).eq('id', next.id).eq('status', 'todo').select('id')
  if (!claimed.data?.length) return

  const run = await db().from('runs').insert({ task_id: next.id, trigger: 'timer' }).select('id').single()
  const runId = (run.data as { id: number } | null)?.id
  await ensureChrome()
  const { code, out, timedOut } = await runClaude(next)
  const ok = code === 0 && !out.is_error && !timedOut
  const summary = (out.result ?? '').trim().slice(0, 3000)

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
  const after = await getTask(next.id)
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
  }

  const icon = { ok: '✅', timeout: '⏱️', error: '⚠️', unverified: '❔', blocked: '🚧' }[outcome.run]
  await notify(`${icon} **#${next.id} ${next.title}** (run ${runId ?? '?'})\n${summary || '(no output)'}`)
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
