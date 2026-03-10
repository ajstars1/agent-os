#!/usr/bin/env node
import 'dotenv/config';
import { loadConfig } from '@agent-os/shared';
import { bootstrap } from '@agent-os/core';
import { Repl } from './repl.js';

function parseArgs(argv: string[]): { agent?: string; model?: string } {
  const result: { agent?: string; model?: string } = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--agent' && argv[i + 1]) {
      result.agent = argv[i + 1];
      i++;
    } else if (argv[i] === '--model' && argv[i + 1]) {
      result.model = argv[i + 1];
      i++;
    }
  }
  return result;
}

async function main(): Promise<void> {
  const _args = parseArgs(process.argv);

  let config;
  try {
    config = loadConfig(process.env);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Configuration error: ${message}\n`);
    process.exit(1);
  }

  let bootstrapped;
  try {
    bootstrapped = await bootstrap(config);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Bootstrap error: ${message}\n`);
    process.exit(1);
  }

  const { engine, skills, memory, tools, hamStore, hamCompressor } = bootstrapped;
  const channelId = process.pid.toString();

  const repl = new Repl(engine, skills, channelId, hamStore, hamCompressor);

  // Graceful shutdown
  const shutdown = (): void => {
    memory.close();
    hamStore.close();
    tools.disconnectAll();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await repl.run();
  shutdown();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});
