/**
 * Cron scheduler daemon.
 *
 * Polls `~/.agent-os/cron/jobs.db` every POLL_INTERVAL_MS for due jobs,
 * executes them via the agent HTTP API (POST /chat), and delivers output.
 *
 * Run: `aos cron daemon` or import `startCronDaemon()` in a persistent process.
 */

import { getDueJobs, updateJobAfterRun, type CronJob, type JobStatus } from './jobs.js';
import { deliver } from './delivery.js';

const POLL_INTERVAL_MS = 30_000; // 30 seconds
const AGENT_API_URL = process.env['AGENT_OS_WEB_URL'] ?? 'http://localhost:3000';

let _running = false;
let _timer: ReturnType<typeof setInterval> | null = null;

async function runJob(job: CronJob): Promise<void> {
  let status: JobStatus = 'error';
  let output = '';

  try {
    // Call the agent web API to execute the prompt
    const res = await fetch(`${AGENT_API_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: job.prompt,
        conversationId: `cron-${job.id}`,
        model: job.model,
      }),
      signal: AbortSignal.timeout(300_000), // 5 min max per job
    });

    if (!res.ok) {
      output = `HTTP ${res.status}: ${await res.text().catch(() => '')}`;
      status = 'error';
    } else {
      const json = await res.json() as { content?: string; response?: string };
      output = json.content ?? json.response ?? '(no output)';
      status = 'success';
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output = msg.includes('timeout') ? `Timeout after 5 minutes` : msg;
    status = msg.includes('timeout') ? 'timeout' : 'error';
  }

  // Deliver output
  await deliver(job.id, job.name, output, job.deliver).catch(() => {});

  // Update job record
  updateJobAfterRun(job.id, status, job.schedule);
}

async function tick(): Promise<void> {
  if (_running) return;
  _running = true;

  try {
    const due = getDueJobs();
    if (due.length === 0) return;

    // Run due jobs in parallel (cap at 5 concurrent)
    const batches: CronJob[][] = [];
    for (let i = 0; i < due.length; i += 5) {
      batches.push(due.slice(i, i + 5));
    }
    for (const batch of batches) {
      await Promise.allSettled(batch.map(runJob));
    }
  } finally {
    _running = false;
  }
}

export function startCronDaemon(pollIntervalMs = POLL_INTERVAL_MS): void {
  if (_timer) return; // already running
  // Run immediately, then on interval
  tick().catch(console.error);
  _timer = setInterval(() => tick().catch(console.error), pollIntervalMs);
}

export function stopCronDaemon(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

// Self-contained CLI entry: `node scheduler.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('[cron] Daemon started. Poll interval:', POLL_INTERVAL_MS / 1000, 's');
  startCronDaemon();

  process.on('SIGINT', () => {
    stopCronDaemon();
    process.exit(0);
  });
}
