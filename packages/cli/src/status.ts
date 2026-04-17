#!/usr/bin/env node
/**
 * agent status — terminal view of the AgentOS background learner.
 *
 * Works anywhere: SSH, headless, no GUI. One HTTP call to the engine API.
 *
 * Usage:
 *   agent status
 *   ask --status     (alias)
 */

import { fileURLToPath } from 'node:url';

const ENGINE_URL = process.env['AGENT_ENGINE_URL'] ?? 'http://localhost:8765';

// ── ANSI ──────────────────────────────────────────────────────────────────────
const ESC = '\x1b';
const reset  = `${ESC}[0m`;
const bold   = (s: string) => `${ESC}[1m${s}${reset}`;
const dim    = (s: string) => `${ESC}[2m${s}${reset}`;
const green  = (s: string) => `${ESC}[32m${s}${reset}`;
const yellow = (s: string) => `${ESC}[33m${s}${reset}`;
const red    = (s: string) => `${ESC}[31m${s}${reset}`;
const cyan   = (s: string) => `${ESC}[36m${s}${reset}`;
const white  = (s: string) => `${ESC}[97m${s}${reset}`;

function bar(filled: number, total: number, width = 20): string {
  const pct = Math.min(1, filled / Math.max(1, total));
  const n = Math.round(pct * width);
  return dim('[') + green('█'.repeat(n)) + dim('░'.repeat(width - n)) + dim(']');
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────
async function fetchJSON<T>(path: string, timeout = 4000): Promise<T | null> {
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeout);
    const res = await fetch(`${ENGINE_URL}${path}`, { signal: ctrl.signal });
    clearTimeout(id);
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface Stats {
  running: boolean;
  maturity: string;
  episode_count: number;
  next_unlock: {
    level: string;
    at: number;
    remaining: number;
    unlocks: string;
  };
  predictions_today: number;
  interest_topics: number;
  graph_edges: number;
  last_decay_pass?: string;
  last_interest_pass?: string;
  last_prediction_pass?: string;
}

interface Prediction {
  topic: string;
  confidence: number;
  source: string;
}

interface HotTopic {
  topic: string;
  weight: number;
  count: number;
}

interface AuditEntry {
  timestamp_ms: number;
  param_key: string;
  old_value: number;
  new_value: number;
  delta_pct: number;
  reason: string;
  maturity_at: string;
  applied: number;
}

// ── Rendering ─────────────────────────────────────────────────────────────────
const MATURITY_EMOJI: Record<string, string> = {
  child: '🧒',
  teen: '🧑',
  young_adult: '🧑‍💻',
  adult: '🧠',
};

function relTime(unixSec: number): string {
  const secs = Math.floor(Date.now() / 1000) - unixSec;
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function ln(s = '') { process.stdout.write(s + '\n'); }
function row(label: string, value: string) {
  process.stdout.write(`  ${dim(label.padEnd(22))} ${value}\n`);
}

export async function main(): Promise<void> {
  ln();
  ln(bold('  AgentOS — Background Learner Status'));
  ln(dim('  ' + '─'.repeat(46)));

  // ── Engine reachability ───────────────────────────────────────────────────
  const [stats, predictions, hotTopics, auditLog] = await Promise.all([
    fetchJSON<Stats>('/learner/stats'),
    fetchJSON<Prediction[]>('/learner/predictions'),
    fetchJSON<HotTopic[]>('/learner/hot-topics?limit=8'),
    fetchJSON<AuditEntry[]>('/learner/audit-log?limit=3'),
  ]);

  if (!stats) {
    ln();
    ln(`  ${red('●')} ${bold('Engine offline')}  ${dim(`(${ENGINE_URL})`)}`);
    ln();
    ln(dim('  Start with:'));
    ln(dim('    cd packages/engine && ./install-service.sh'));
    ln(dim('    # or manually: poetry run uvicorn engine.app:app --port 8000'));
    ln();
    process.exit(1);
  }

  // ── Status header ─────────────────────────────────────────────────────────
  const dot = stats.running ? green('●') : yellow('●');
  const statusText = stats.running ? green('Running') : yellow('Engine up, learner idle');
  const emoji = MATURITY_EMOJI[stats.maturity] ?? '🤖';
  const matLabel = stats.maturity.replace('_', ' ');

  ln();
  ln(`  ${dot} ${bold('AgentOS Learner')}  ${statusText}`);
  ln();

  // ── Identity ──────────────────────────────────────────────────────────────
  ln(`  ${bold(cyan('Identity'))}`);
  row('Maturity', `${emoji}  ${white(matLabel)}`);
  row('Episodes', white(String(stats.episode_count)));

  const next = stats.next_unlock;
  if (next && next.remaining > 0) {
    const filled = next.at - next.remaining;
    row('Progress', `${bar(filled, next.at, 18)} ${dim(`${next.remaining} to ${next.level}`)}`);
    row('Next unlock', dim(next.unlocks));
  } else {
    row('Progress', green('Fully unlocked'));
  }

  ln();

  // ── Memory health ─────────────────────────────────────────────────────────
  ln(`  ${bold(cyan('Memory'))}`);
  row('Interest topics', white(String(stats.interest_topics)));
  if (stats.graph_edges !== undefined) {
    row('Graph edges', white(String(stats.graph_edges)));
  }
  row("Today's predictions", white(String(stats.predictions_today)));

  if (stats.last_decay_pass) {
    row('Last decay pass', dim(relTime(parseInt(stats.last_decay_pass))));
  }
  if (stats.last_prediction_pass) {
    row('Last prediction pass', dim(relTime(parseInt(stats.last_prediction_pass))));
  }

  ln();

  // ── Today's predictions ───────────────────────────────────────────────────
  if (predictions && predictions.length > 0) {
    ln(`  ${bold(cyan("Today's Predictions"))}`);
    for (const p of predictions.slice(0, 6)) {
      const conf = Math.round(p.confidence * 100);
      const confColor = conf >= 70 ? green : conf >= 40 ? yellow : dim;
      const confStr = confColor(`${conf}%`.padStart(4));
      ln(`    ${confStr}  ${white(p.topic)}  ${dim(p.source)}`);
    }
    ln();
  }

  // ── Hot topics ────────────────────────────────────────────────────────────
  if (hotTopics && hotTopics.length > 0) {
    ln(`  ${bold(cyan('Hot Topics'))}`);
    const maxW = hotTopics[0]?.weight ?? 1;
    for (const t of hotTopics.slice(0, 6)) {
      const pct = Math.round((t.weight / maxW) * 10);
      const mini = '▪'.repeat(pct) + dim('▫'.repeat(10 - pct));
      ln(`    ${mini}  ${white(t.topic)}  ${dim(`×${t.count}`)}`);
    }
    ln();
  }

  // ── Recent self-updates ───────────────────────────────────────────────────
  if (auditLog && auditLog.length > 0) {
    ln(`  ${bold(cyan('Recent Self-Updates'))}`);
    for (const entry of auditLog) {
      const sign = entry.delta_pct >= 0 ? green('+') : red('-');
      const when = dim(relTime(Math.floor(entry.timestamp_ms / 1000)));
      ln(`    ${when}  ${sign}${white(entry.param_key)}  ${dim(`${entry.old_value} → ${entry.new_value}`)}`);
      ln(`         ${dim(entry.reason.slice(0, 70) + (entry.reason.length > 70 ? '…' : ''))}`);
    }
    ln();
  }

  // ── Links ─────────────────────────────────────────────────────────────────
  ln(dim('  ' + '─'.repeat(46)));
  ln(dim(`  Self-model:  ${ENGINE_URL}/learner/self-model`));
  ln(dim(`  Audit log:   ${ENGINE_URL}/learner/audit-log`));
  ln(dim(`  API docs:    ${ENGINE_URL}/docs`));
  ln();
}

// Only auto-run when invoked directly (not when imported by ask --status)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
