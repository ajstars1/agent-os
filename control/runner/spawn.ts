// How the runner starts Claude for one task: prompt, rules and hard caps (aos v2 Phase 0, plan §2.5).
// Caps are enforced by CLI flags, not by asking nicely in the prompt.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Task } from '../lib/db'
import { approvalIdFromTitle } from '../lib/send-gate'
import { stateDir } from '../lib/discord'

export type CapKind = 'send' | 'check' | 'task'

export interface Caps {
  kind: CapKind
  model: 'sonnet' | 'opus'
  maxTurns: number
  maxUsd: number
}

const TURNS: Record<CapKind, number> = { send: 15, check: 25, task: 60 }
const USD: Record<CapKind, number> = { send: 1, check: 2, task: 5 }

// The only MCP servers a runner session gets (claude-in-chrome comes from --chrome).
export const RUNNER_MCP_SERVERS = ['aos', 'pilot-browser'] as const

export const isApprovedSend = (task: Pick<Task, 'title'>): boolean => approvalIdFromTitle(task.title) !== null

export const capKind = (task: Pick<Task, 'title' | 'kind'>): CapKind =>
  isApprovedSend(task) || task.kind === 'send' ? 'send' : task.kind === 'check' ? 'check' : 'task'

// Sonnet unless the task prompt itself asks for Opus.
export const capsFor = (task: Pick<Task, 'title' | 'kind' | 'prompt'>): Caps => {
  const kind = capKind(task)
  // A feed post is a bigger send: re-checks from the draft header, the post, the first comment, then verify.
  const post = kind === 'send' && /^SEND APPROVED #\d+ \(linkedin-post\b/i.test(task.title)
  return {
    kind,
    model: /\bopus\b/i.test(task.prompt ?? '') ? 'opus' : 'sonnet',
    maxTurns: post ? 30 : TURNS[kind],
    maxUsd: post ? 2 : USD[kind],
  }
}

const RESULT_RULE = `The very last line of your reply must be exactly one result line, JSON on one line:
AOS_RESULT {"status":"done","summary":"<one line>"}
status is "done" only if the task's goal was met, "blocked" if you could not proceed (login, CAPTCHA, missing input), "failed" otherwise. Without this line (or task_done) the run counts as unverified and the task is retried.`

const BROWSER_RULE = `Browser: Claude in Chrome, in a new tab you close when done. "Disconnected" means Chrome is closed: run \`bash ~/Developer/Ayush/agent-os/control/hooks/ensure-chrome.sh\`, then retry twice. For sites the extension can't use (reddit.com), pilot-browser with mode "managed", profile "aos" works unattended; never mode "attach" here (it needs a person to click Allow). A site not logged in there: skip and say so.`

export const RULES = `You are running unattended, started by the aos runner for one task. Ayush is not watching.
Rules, in priority order:
1. Never send, post, comment, connect, email or message anyone yourself. For every outbound item, call approval_request (aos MCP) with the exact text, the channel and the recipient. Ayush approves on Discord, and an approved draft comes back to you as its own task.
2. Never buy anything, delete anything, change account settings, accept terms or enter credentials. If login, a CAPTCHA or a payment is needed, stop and say so.
3. Read and follow CLAUDE.md, notes/outreach-playbook.md and the plan file named in the task before acting. No em dashes in any copy.
4. Read-only checks (inboxes, Ads Manager, dashboards) are fine. Log what you find in the plan file the task names, and call log_activity for every reply or accept.
5. ${BROWSER_RULE}
6. When finished, call task_done with the task id and a one-line note. If blocked, call task_update with status "todo" and the reason in notes.
7. End with a plain summary of 8 lines or fewer: what you did, what needs Ayush.
8. ${RESULT_RULE}`

// An approved word-for-word send needs no context: no CLAUDE.md, playbook or plan-file reads.
export const SEND_RULES = `You are running unattended, started by the aos runner to send one message Ayush already approved. Ayush is not watching.
Rules, in priority order:
1. Send exactly the approved text in the task, word for word, to that recipient on that channel. Nothing else: no edits, no extra messages, no other recipients.
2. Do not read files (no CLAUDE.md, playbook or plan files); everything you need is in the task.
3. Never buy anything, delete anything, change account settings, accept terms or enter credentials. If login, a CAPTCHA or a payment is needed, stop and say so.
4. ${BROWSER_RULE}
5. After sending, call approval_mark_sent and log_activity, then task_done with the task id and a one-line note. If you could not send, call approval_mark_sent with failed true and the reason.
6. ${RESULT_RULE}`

export const buildPrompt = (task: Task): string => {
  const send = isApprovedSend(task)
  return (
    `aos task #${task.id}: ${task.title}\nVenture: ${task.venture}. Kind: ${task.kind}.` +
    (task.source && !send ? `\nPlan file: ${task.source}` : '') +
    (task.notes ? `\nNotes so far:\n${task.notes}` : '') +
    `\n\nInstructions:\n${task.prompt ?? task.title}`
  )
}

// Coordinator mode (on in Ayush's user settings) turns a run into a fan-out of subagents. Runner sessions do one
// task, so it is off: dropped from the child env (childEnv) and overridden in flag settings, which outrank user settings.
export const NO_COORDINATOR_SETTINGS = JSON.stringify({ env: { CLAUDE_CODE_COORDINATOR_MODE: '0' } })

export const childEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const out = { ...env }
  delete out.CLAUDE_CODE_COORDINATOR_MODE
  return out
}

export const buildArgs = (task: Task, mcpConfigPath: string): string[] => {
  const caps = capsFor(task)
  return [
    '-p', buildPrompt(task),
    '--permission-mode', 'auto',
    '--output-format', 'json',
    '--model', caps.model,
    '--max-turns', String(caps.maxTurns),
    '--max-budget-usd', String(caps.maxUsd),
    '--strict-mcp-config', '--mcp-config', mcpConfigPath,
    '--chrome',
    // unattended runs never drive the desktop: Ayush may be using it
    '--disallowedTools', 'mcp__desk',
    '--settings', NO_COORDINATOR_SETTINGS,
    '--append-system-prompt', isApprovedSend(task) ? SEND_RULES : RULES,
  ]
}

interface McpServers {
  mcpServers?: Record<string, unknown>
}

// Picks the runner's MCP servers out of the user's Claude config (it holds the aos token, so the file is 0600 and
// lives in the state dir, outside the repo).
export const pickServers = (config: McpServers): Record<string, unknown> => {
  const all = config.mcpServers ?? {}
  const picked: Record<string, unknown> = {}
  for (const name of RUNNER_MCP_SERVERS) if (all[name]) picked[name] = all[name]
  if (!picked.aos) throw new Error('runner MCP config: no "aos" server in ~/.claude.json')
  return picked
}

export const writeMcpConfig = (): string => {
  const config = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as McpServers
  const dir = stateDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'runner-mcp.json')
  writeFileSync(path, JSON.stringify({ mcpServers: pickServers(config) }), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}
