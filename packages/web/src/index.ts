import 'dotenv/config';
import { serve } from '@hono/node-server';
import { loadConfig, createLogger } from '@agent-os/shared';
import { bootstrap } from '@agent-os/core';
import { createServer } from './server.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Configuration error: ${message}\n`);
    process.exit(1);
  }

  const logger = createLogger('web', config.LOG_LEVEL);

  let bootstrapped;
  try {
    bootstrapped = await bootstrap(config);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, `Bootstrap error: ${message}`);
    process.exit(1);
  }

  const { engine, agents, memory, tools, skills } = bootstrapped;

  const app = createServer({
    engine,
    agents,
    memory,
    tools,
    config,
    logger,
  });

  const server = serve({ fetch: app.fetch, port: config.WEB_PORT }, (info) => {
    logger.info({ port: info.port }, 'AgentOS web server started');
  });

  const shutdown = (): void => {
    logger.info('Shutting down web server...');
    skills.stopWatching();
    memory.close();
    tools.disconnectAll();
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});
