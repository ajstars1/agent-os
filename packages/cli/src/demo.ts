#!/usr/bin/env node
/**
 * AgentOS Capability Showcase — `ask --demo [section]`
 *
 * Full animated showcase or individual sections for screen recording.
 *
 * Usage:
 *   ask --demo                   animated full run
 *   ask --demo speed             live latency benchmark
 *   ask --demo memory            HAM memory depth
 *   ask --demo companion         what it knows about you
 *   ask --demo learner           background self-improvement
 *   ask --demo skills            skills + tools inventory
 *   ask --demo arch              multi-agent architecture
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

function resolveEnv(): void {
  const globalEnv = join(homedir(), '.agent-os', '.env');
  if (existsSync(globalEnv)) dotenv.config({ path: globalEnv, override: false });
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) { dotenv.config({ path: candidate, override: false }); break; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '../../../.env'), override: false });
}
resolveEnv();

import { bootstrap } from '@agent-os-core/core';
import { loadConfig } from '@agent-os-core/shared';

// ── ANSI ──────────────────────────────────────────────────────────────────────
const ESC = '\x1b';
const R      = `${ESC}[0m`;
const bold   = (s: string) => `${ESC}[1m${s}${R}`;
const dim    = (s: string) => `${ESC}[2m${s}${R}`;
const cyan   = (s: string) => `${ESC}[36m${s}${R}`;
const green  = (s: string) => `${ESC}[32m${s}${R}`;
const yellow = (s: string) => `${ESC}[33m${s}${R}`;
const red    = (s: string) => `${ESC}[31m${s}${R}`;
const violet = (s: string) => `${ESC}[38;5;141m${s}${R}`;
const teal   = (s: string) => `${ESC}[38;5;38m${s}${R}`;
const white  = (s: string) => `${ESC}[97m${s}${R}`;
const gray   = (s: string) => `${ESC}[90m${s}${R}`;
const blue   = (s: string) => `${ESC}[38;5;75m${s}${R}`;

const LOGO_LINES = [
  `   ▗▄▖  ▗▄▄▖  ▗▄▄▖`,
  `  ▐▌ ▐▌▐▌   ▐▌`,
  `  ▐▛▀▜▌▐▌▝▜▌ ▝▀▚▖`,
  `  ▐▌ ▐▌▝▚▄▞▘▗▄▄▞▘`,
];

// ── Timing ────────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Output helpers ────────────────────────────────────────────────────────────
function w(s: string) { process.stdout.write(s); }

/** Print a line, optionally after a delay. */
async function ln(s = '', delay = 0): Promise<void> {
  if (delay) await sleep(delay);
  process.stdout.write(s + '\n');
}

async function row(label: string, value: string, delay = 0, indent = 4): Promise<void> {
  await ln(`${' '.repeat(indent)}${dim(label.padEnd(24))} ${value}`, delay);
}

async function section(title: string, pauseBefore = 0): Promise<void> {
  if (pauseBefore) await sleep(pauseBefore);
  await ln();
  await ln(`  ${bold(teal('▸'))} ${bold(white(title))}`);
}

function divider(cols = process.stdout.columns || 72): string {
  return dim('  ' + '─'.repeat(Math.min(cols - 4, 54)));
}

// ── Visual elements ───────────────────────────────────────────────────────────
function miniBar(filled: number, total: number, width = 14): string {
  const pct = Math.min(1, filled / Math.max(1, total));
  const n = Math.round(pct * width);
  const color = pct > 0.66 ? green : pct > 0.33 ? yellow : cyan;
  return color('█'.repeat(n)) + dim('░'.repeat(width - n));
}

function speedBar(ms: number, maxMs = 2000, width = 14): string {
  const pct = Math.min(1, ms / maxMs);
  const n = Math.round(pct * width);
  const color = ms < 400 ? green : ms < 900 ? yellow : red;
  return color('▮'.repeat(n)) + dim('▯'.repeat(width - n));
}

// ── Spinner ───────────────────────────────────────────────────────────────────
const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'] as const;

function mkSpinner(label: string) {
  let i = 0;
  const id = setInterval(() => {
    w(`\r    ${dim(FRAMES[i++ % FRAMES.length] ?? '⠋')}  ${dim(label)}`);
  }, 80);
  return { stop: () => { clearInterval(id); w('\r\x1b[2K'); } };
}

// ── Speed benchmark ───────────────────────────────────────────────────────────
interface BenchResult { provider: string; firstTokenMs: number; totalMs: number; outputTokens: number; }

async function runBench(boot: Awaited<ReturnType<typeof bootstrap>>, provider: 'claude' | 'gemini'): Promise<BenchResult | null> {
  const start = Date.now();
  let firstToken = 0;
  let outputTokens = 0;
  try {
    for await (const chunk of boot.engine.chat({
      conversationId: `demo-bench-${provider}-${Date.now()}`,
      message: 'Reply with exactly one word: READY',
      forceModel: provider,
    })) {
      if (chunk.type === 'text' && chunk.content && firstToken === 0) firstToken = Date.now() - start;
      if (chunk.type === 'usage' && chunk.usage) outputTokens = chunk.usage.outputTokens;
      if (chunk.type === 'done') break;
    }
  } catch { return null; }
  return { provider, firstTokenMs: firstToken || Date.now() - start, totalMs: Date.now() - start, outputTokens };
}

// ── Version ───────────────────────────────────────────────────────────────────
function getVersion(): string {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), '../../../package.json');
    return (JSON.parse(readFileSync(p, 'utf-8')) as { version?: string }).version ?? '0.2.1';
  } catch { return '0.2.1'; }
}

// ── Section renderers ─────────────────────────────────────────────────────────

type Boot = Awaited<ReturnType<typeof bootstrap>>;

async function renderHeader(slow: boolean): Promise<void> {
  await ln();
  for (const line of LOGO_LINES) {
    await ln(violet(line), slow ? 60 : 0);
  }
  await ln();
  await ln(`  ${bold(white('AgentOS'))}  ${dim('Capability Showcase')}  ${gray(`v${getVersion()}`)}`, slow ? 80 : 0);
  await ln(`  ${dim('Everything below is live — pulled from your running system.')}`, slow ? 60 : 0);
  await ln(divider(), slow ? 60 : 0);
}

async function renderProviders(config: ReturnType<typeof loadConfig>, slow: boolean): Promise<void> {
  const d = slow ? 80 : 0;
  await section('Providers', slow ? 400 : 0);
  const hasClaude = !!config.ANTHROPIC_API_KEY;
  const hasGemini = !!config.GOOGLE_API_KEY;
  await row('Claude (Sonnet)',   hasClaude ? green('✓ connected') : red('✗ no API key'), d);
  await row('Gemini (Flash/Pro)', hasGemini ? green('✓ connected') : red('✗ no API key'), d);
  await row('Routing', config.DEFAULT_MODEL === 'auto'
    ? cyan('auto') + dim(' — picks best model per request')
    : cyan(config.DEFAULT_MODEL), d);
}

async function renderSpeed(boot: Boot, config: ReturnType<typeof loadConfig>, slow: boolean): Promise<void> {
  const d = slow ? 70 : 0;
  await section('Speed  ' + dim('(live benchmark)'), slow ? 500 : 0);
  await ln(dim('    Measuring cold-start latency…'), d);

  const results: BenchResult[] = [];
  if (config.ANTHROPIC_API_KEY) {
    const sp = mkSpinner('timing Claude Sonnet…');
    const r = await runBench(boot, 'claude');
    sp.stop();
    if (r) results.push(r);
  }
  if (config.GOOGLE_API_KEY) {
    const sp = mkSpinner('timing Gemini Flash…');
    const r = await runBench(boot, 'gemini');
    sp.stop();
    if (r) results.push(r);
  }

  if (results.length === 0) {
    await ln(dim('    (no providers configured — skipped)'), d);
    return;
  }

  await ln('', d);
  const maxTTFT = Math.max(...results.map(r => r.firstTokenMs));
  for (const r of results) {
    const label = r.provider === 'claude' ? cyan('Claude Sonnet') : green('Gemini Flash ');
    const ttft  = r.firstTokenMs;
    const color = ttft < 400 ? green : ttft < 900 ? yellow : red;
    const bar   = speedBar(ttft, Math.max(maxTTFT * 1.2, 1000));
    const tokS  = r.outputTokens > 0 ? dim(`  ${Math.round((r.outputTokens / r.totalMs) * 1000)} tok/s`) : '';
    await ln(`    ${label}  ${bar}  ${color(`${ttft}ms`)} to first token${tokS}`, slow ? 120 : 0);
  }
  await ln('');
  await ln(dim('    ⟳ Latency shown is cold-start — warm requests are faster.'), d);
}

async function renderMemory(boot: Boot, slow: boolean): Promise<void> {
  const d = slow ? 70 : 0;
  await section('HAM Memory  ' + dim('(Hierarchical Associative Memory)'), slow ? 500 : 0);

  const allTopics = boot.hamStore.getAllL0();
  const allStats  = boot.hamStore.getAllChunkStats();

  if (allTopics.length === 0) {
    await row('Status',     dim('empty — grows as you use it'), d);
    await row('How it works', dim('5 layers: L0 instant → L4 compressed · no vector DB'), d);
    await ln('');
    await ln(dim('    HAM retrieves relevant context in <5ms without any external database.'), d);
    return;
  }

  const totalL0Tokens = allStats.reduce((acc, s) => acc + Math.ceil(s.l0.length / 4), 0);
  const mostAccessed  = [...allStats].sort((a, b) => b.accessCount - a.accessCount).slice(0, 5);
  const maxAccess     = mostAccessed[0]?.accessCount ?? 1;

  await row('Topics stored',     white(String(allTopics.length)), d);
  await row('L0 token footprint', white(`~${totalL0Tokens}`) + dim(' tokens in working memory'), d);
  await row('Layers',             dim('L0 instant · L1 topic · L2 domain · L3 session · L4 compressed'), d);
  await ln('', d);
  await ln(`    ${dim('Most retrieved:')}`, d);
  for (const s of mostAccessed) {
    const bar  = miniBar(s.accessCount, maxAccess);
    const name = white(s.topic.slice(0, 26).padEnd(26));
    await ln(`    ${bar}  ${name}  ${dim(`×${s.accessCount}`)}`, slow ? 90 : 0);
  }
  await ln('');
  await ln(dim('    HAM retrieves relevant context in <5ms — no vector DB required.'), d);
}

async function renderCompanion(boot: Boot, slow: boolean): Promise<void> {
  const d = slow ? 80 : 0;
  await section('Companion Profile  ' + dim('(what it knows about you)'), slow ? 500 : 0);

  const profile  = boot.userProfileStore.get('default');
  const episodes = boot.episodicStore.getTopN(4, []);

  const hasData = profile.sessionCount > 1 || profile.primaryStack.length > 0 ||
    profile.currentProjects.length > 0 || Object.keys(profile.facts).length > 0;

  if (!hasData) {
    await row('Status',     dim('new — profile builds from your conversations'), d);
    await row('What grows', dim('name · role · stack · projects · communication style'), d);
    await row('How',        dim('silently inferred after every exchange — you never fill a form'), d);
  } else {
    if (profile.name)  await row('Name',    white(profile.name), d);
    if (profile.role)  await row('Role',    white(profile.role), d);
    await row('Sessions',   white(String(profile.sessionCount)) + dim(' conversations since ' + profile.firstSeen.slice(0, 10)), d);
    if (profile.primaryStack.length > 0)
      await row('Stack',    white(profile.primaryStack.slice(0, 6).join('  ·  ')), d);
    const active = profile.currentProjects.filter(p => p.status === 'active').slice(0, 3);
    if (active.length > 0)
      await row('Projects',  active.map(p => white(p.name)).join(dim('  ·  ')), d);
    for (const [k, v] of Object.entries(profile.facts).slice(0, 3))
      await row(k, dim(v), d);
  }

  if (episodes.length > 0) {
    await ln('');
    await ln(`    ${dim('Episodic memory  ' + dim('(decays like human memory — vivid → faint over days):'))}`, d);
    for (const ep of episodes) {
      const tone  = ep.tone === 'excited' ? green('▲') : ep.tone === 'frustrated' ? red('▼') : dim('·');
      const score = Math.round(ep.decayScore * 100);
      const sc    = score > 60 ? green(`${score}%`) : score > 30 ? yellow(`${score}%`) : dim(`${score}%`);
      await ln(`    ${tone} ${sc}  ${ep.summary.slice(0, 62)}${ep.summary.length > 62 ? '…' : ''}`, slow ? 90 : 0);
    }
  }
}

async function renderLearner(boot: Boot, slow: boolean): Promise<void> {
  const d = slow ? 80 : 0;
  await section('Background Learner  ' + dim('(self-improving while you sleep)'), slow ? 500 : 0);

  const warmup = boot.learnerClient.warmup();

  if (!warmup.hasData) {
    await row('Status',     dim('no data yet'), d);
    await row('Triggers',   dim('after 5 min idle — you don\'t need to do anything'), d);
    await row('What it does', dim('prunes redundant memories'), d);
    await row('',           dim('extracts permanent facts into semantic graph'), d);
    await row('',           dim('predicts what you\'ll need next session'), d);
    await row('',           dim('self-tunes its own retrieval parameters'), d);
  } else {
    const hot  = warmup.hotTopics.slice(0, 5);
    const pred = warmup.predictions.slice(0, 4);
    if (hot.length > 0) {
      await ln(`    ${dim('Hot topics right now:')}`, d);
      for (const t of hot) {
        const bar = miniBar(t.weight, hot[0]?.weight ?? 1, 10);
        await ln(`    ${bar}  ${white(t.topic)}  ${dim(`×${t.count}`)}`, slow ? 80 : 0);
      }
      await ln('');
    }
    if (pred.length > 0) {
      await ln(`    ${dim('Predicting you\'ll need:')}`, d);
      for (const p of pred) {
        const conf = Math.round(p.confidence * 100);
        const cc   = conf > 70 ? green : conf > 40 ? yellow : dim;
        await ln(`    ${cc(`${conf}%`.padStart(4))}  ${white(p.topic)}  ${dim(p.source)}`, slow ? 80 : 0);
      }
    }
  }
  await ln('');
  await ln(dim('    Idle 5 min → sleep cycle → memory pruned · facts extracted · model updated.'), d);
}

async function renderSkills(boot: Boot, slow: boolean): Promise<void> {
  const d = slow ? 80 : 0;
  await section('Skills & Tools', slow ? 500 : 0);

  const skillNames    = boot.skills.getSkillNames();
  const toolList      = boot.tools.getTools();
  const builtins      = ['read_file','write_file','edit','glob','grep','bash','ls','web_fetch','remember'];
  const mcpCount      = Math.max(0, toolList.length - builtins.length);

  await row('Skills',       white(String(skillNames.length)) + dim('  invoke with /skillname [args]'), d);
  await row('Built-in tools', white(String(builtins.length)) + dim(`  ${builtins.join(' · ')}`), d);
  await row('MCP tools',    white(String(mcpCount)) + dim(mcpCount > 0 ? '  additional via .mcp.json' : '  (add servers in .mcp.json)'), d);

  if (skillNames.length > 0) {
    await ln('');
    const cols1 = skillNames.slice(0, 8).map(s => teal('/' + s)).join(dim('  '));
    await ln(`    ${cols1}`, slow ? 80 : 0);
    if (skillNames.length > 8) {
      const cols2 = skillNames.slice(8, 16).map(s => teal('/' + s)).join(dim('  '));
      await ln(`    ${cols2}`, slow ? 80 : 0);
    }
    if (skillNames.length > 16)
      await ln(`    ${dim(`… and ${skillNames.length - 16} more`)}`, slow ? 60 : 0);
  }
}

async function renderArch(slow: boolean): Promise<void> {
  const d = slow ? 90 : 0;
  await section('Multi-Agent Architecture', slow ? 500 : 0);

  await ln(`    ${dim('Every message is classified first:')}`, d);
  await ln('');
  await ln(`    ${dim('simple')}  ${dim('──→')}  ${cyan('Single agent')}  ${dim('+ 9 tools  (read · write · bash · grep · …)')}`, slow ? 100 : 0);
  await ln(`    ${dim('complex')} ${dim('──→')}  ${cyan('Orchestrator')}  ${dim('→ decomposes into typed tasks')}`, slow ? 100 : 0);
  await ln(`             ${dim('→ parallel workers:')}  ${blue('CodeAgent')}  ${green('ResearchAgent')}  ${yellow('PlannerAgent')}`, slow ? 100 : 0);
  await ln(`             ${dim('→ reducer synthesises all outputs → one coherent reply')}`, slow ? 100 : 0);
  await ln('');
  await row('Parallel workers',    white('3') + dim('  max concurrent'),           d);
  await row('Tool iterations',     white('40') + dim(' per agent  (hard cap)'),    d);
  await row('Worker timeout',      white('90s') + dim(' then hard-abort — no hangs'), d);
  await row('CodeAgent',           dim('full file tools — glob · read · edit · bash'), d);
  await row('ResearchAgent',       dim('Gemini + Google Search grounding'),        d);
  await row('PlannerAgent',        dim('read-only codebase exploration → plan'),   d);
  await ln('');
  await ln(dim('    Routing is automatic — you never pick simple vs complex.'), d);
}

async function renderFooter(slow: boolean): Promise<void> {
  const d = slow ? 70 : 0;
  await ln('', d);
  await ln(divider(), d);
  await ln('');
  await ln(`  ${bold('Commands:')}  ${teal('aos')}  ${dim('open REPL')}   ${teal('ask "<q>"')}  ${dim('one-shot')}   ${teal('ask --status')}  ${dim('learner health')}`, slow ? 80 : 0);
  await ln(`             ${dim('ask --demo speed')}  ${dim('·')}  ${dim('ask --demo memory')}  ${dim('·')}  ${dim('ask --demo companion')}  ${dim('·')}  ${dim('ask --demo arch')}`, slow ? 80 : 0);
  await ln('');
}

// ── Sub-command map ───────────────────────────────────────────────────────────

type SectionKey = 'speed' | 'memory' | 'companion' | 'learner' | 'skills' | 'arch';

const SECTION_LABELS: Record<SectionKey, string> = {
  speed:     'Speed Benchmark',
  memory:    'HAM Memory',
  companion: 'Companion Profile',
  learner:   'Background Learner',
  skills:    'Skills & Tools',
  arch:      'Architecture',
};

async function runSection(key: SectionKey, boot: Boot, config: ReturnType<typeof loadConfig>): Promise<void> {
  await ln();
  await ln(`  ${violet('▸')}  ${bold(white('AgentOS'))}  ${dim(SECTION_LABELS[key])}`);
  await ln(divider());

  switch (key) {
    case 'speed':     await renderSpeed(boot, config, false); break;
    case 'memory':    await renderMemory(boot, false); break;
    case 'companion': await renderCompanion(boot, false); break;
    case 'learner':   await renderLearner(boot, false); break;
    case 'skills':    await renderSkills(boot, false); break;
    case 'arch':      await renderArch(false); break;
  }

  await ln('');
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function main(subcommand?: string): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`Config error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  config = { ...config, LOG_LEVEL: 'error' as const };

  const SECTIONS: SectionKey[] = ['speed', 'memory', 'companion', 'learner', 'skills', 'arch'];
  const sub = subcommand?.toLowerCase().trim();

  if (sub && SECTIONS.includes(sub as SectionKey)) {
    // Individual section — boot engine, render just that section, exit
    const sp = mkSpinner('loading…');
    const boot = await bootstrap(config);
    sp.stop();
    await runSection(sub as SectionKey, boot, config);
    boot.engine.cancelIdleTimer();
    boot.skills.stopWatching();
    return;
  }

  // Full animated showcase
  const sp = mkSpinner('booting engine…');
  const boot = await bootstrap(config);
  sp.stop();

  await renderHeader(true);
  await renderProviders(config, true);
  await renderSpeed(boot, config, true);
  await renderMemory(boot, true);
  await renderCompanion(boot, true);
  await renderLearner(boot, true);
  await renderSkills(boot, true);
  await renderArch(true);
  await renderFooter(true);

  boot.engine.cancelIdleTimer();
  boot.skills.stopWatching();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Grab sub-command when invoked directly: `node demo.js speed`
  const sub = process.argv[2];
  main(sub).catch((e) => {
    process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
