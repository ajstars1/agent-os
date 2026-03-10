import 'dotenv/config';
import { loadConfig, createLogger } from '@agent-os/shared';
import { bootstrap } from '@agent-os/core';
import { createBot } from './bot.js';
import { registerCommands } from './commands/index.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Configuration error: ${message}\n`);
    process.exit(1);
  }

  if (!config.DISCORD_TOKEN) {
    process.stderr.write('DISCORD_TOKEN is required for the Discord adapter\n');
    process.exit(1);
  }

  if (!config.DISCORD_CLIENT_ID) {
    process.stderr.write('DISCORD_CLIENT_ID is required for slash command registration\n');
    process.exit(1);
  }

  const logger = createLogger('discord', config.LOG_LEVEL);

  let bootstrapped;
  try {
    bootstrapped = await bootstrap(config);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, `Bootstrap error: ${message}`);
    process.exit(1);
  }

  const { engine, memory, tools } = bootstrapped;

  // Register slash commands
  try {
    await registerCommands(
      config.DISCORD_TOKEN,
      config.DISCORD_CLIENT_ID,
      config.DISCORD_GUILD_ID,
      logger,
    );
  } catch {
    logger.warn('Slash command registration failed — continuing without slash commands');
  }

  const client = createBot(engine, config, logger);

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down Discord bot...');
    memory.close();
    tools.disconnectAll();
    client.destroy();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await client.login(config.DISCORD_TOKEN);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});
