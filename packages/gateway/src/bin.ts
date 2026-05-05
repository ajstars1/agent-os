/**
 * `aos-gateway` CLI entry point.
 *
 * Usage:
 *   aos-gateway                        # start all configured platforms
 *   aos-gateway --only telegram,slack  # start specific platforms only
 *   aos-gateway --list                 # show which platforms have required env vars
 */

import dotenv from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

import { loadConfig, createLogger } from '@agent-os-core/shared';
import { bootstrap } from '@agent-os-core/core';
import { GatewayDaemon, type PlatformName } from './gateway.js';

// ─── Platform env var check ───────────────────────────────────────────────────

const PLATFORM_CHECKS: Record<PlatformName, string[]> = {
  telegram: ['TELEGRAM_BOT_TOKEN'],
  discord: ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID'],
  slack: ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'],
  whatsapp: ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN'],
  signal: ['SIGNAL_CLI_URL', 'SIGNAL_NUMBER'],
  matrix: ['MATRIX_HOMESERVER_URL', 'MATRIX_ACCESS_TOKEN', 'MATRIX_USER_ID'],
  email: ['EMAIL_IMAP_HOST', 'EMAIL_USER', 'EMAIL_PASSWORD'],
};

function listPlatforms(): void {
  console.log('\nPlatform status (based on env vars):\n');
  for (const [name, vars] of Object.entries(PLATFORM_CHECKS)) {
    const missing = vars.filter((v) => !process.env[v]);
    const ok = missing.length === 0;
    const icon = ok ? '✅' : '○ ';
    const detail = ok ? 'configured' : `missing: ${missing.join(', ')}`;
    console.log(`  ${icon} ${name.padEnd(12)} ${detail}`);
  }
  console.log();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--list') || args.includes('-l')) {
    listPlatforms();
    process.exit(0);
  }

  // Parse --only flag
  const onlyIdx = args.findIndex((a) => a === '--only' || a === '-p');
  let only: PlatformName[] | undefined;
  if (onlyIdx >= 0 && args[onlyIdx + 1]) {
    only = args[onlyIdx + 1]!.split(',').map((s) => s.trim() as PlatformName);
  }

  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    process.stderr.write(`Configuration error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const logger = createLogger('gateway', config.LOG_LEVEL);

  let bootstrapped;
  try {
    bootstrapped = await bootstrap(config);
  } catch (err) {
    logger.error({ err }, 'Bootstrap failed');
    process.exit(1);
  }

  const { engine, memory, tools } = bootstrapped;
  const daemon = new GatewayDaemon(engine, logger, only);

  logger.info(
    { platforms: daemon.platformNames, only: only ?? 'all' },
    '[Gateway] Initialising platforms',
  );

  await daemon.start();

  // Print a summary of what's running
  listPlatforms();
  console.log('AgentOS Gateway running. Press Ctrl+C to stop.\n');

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    logger.info('[Gateway] Shutting down...');
    await daemon.stop();
    memory.close();
    tools.disconnectAll();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  // Keep process alive
  setInterval(() => {}, 60_000);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
