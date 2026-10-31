// SessionStart hook: prints what's due so every Claude session starts knowing.
// Runs with: bun --cwd <control> hooks/agenda.ts  (Bun loads .env.local from cwd)
import { agenda, formatAgenda } from '../lib/tasks'

const timeout = setTimeout(() => process.exit(0), 6000)

try {
  const a = await agenda(1)
  const short = { ...a, upcoming: [], undated: [] }
  const body = formatAgenda(short)
  if (body !== 'Nothing open.') {
    process.stdout.write(
      `## aos agenda (from the aos MCP; IST)\n${body}\n\n` +
        `Use the aos MCP tools (agenda, task_done, task_add, approval_request, log_activity) to keep it current. ` +
        `If Ayush's request relates to one of these, update the task when done.\n`,
    )
  }
} catch {
  // never block a session on the tracker
}
clearTimeout(timeout)
