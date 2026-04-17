import { Hono } from 'hono';
import type { AgentEngine, AgentLoader, SQLiteMemoryStore, TieredStore, ToolRegistry } from '@agent-os-core/core';
import type { Config, Logger } from '@agent-os-core/shared';
import { createCors } from './middleware/cors.js';
import { rateLimit } from './middleware/rateLimit.js';
import { healthRoute } from './routes/health.js';
import { chatRoute } from './routes/chat.js';
import { conversationsRoute } from './routes/conversations.js';
import { memoryRoute } from './routes/memory.js';

export interface ServerDeps {
  engine: AgentEngine;
  agents: AgentLoader;
  memory: SQLiteMemoryStore;
  tools: ToolRegistry;
  config: Config;
  logger: Logger;
  hamStore?: TieredStore;
}

export function createServer(deps: ServerDeps): Hono {
  const { engine, agents, memory, config, logger, hamStore } = deps;
  const app = new Hono();

  app.use('*', createCors(config.WEB_CORS_ORIGIN));
  app.use('/chat/*', rateLimit({ windowMs: 60_000, max: 60 }));

  app.route('/health', healthRoute());
  app.route('/chat', chatRoute(engine, agents, logger));
  app.route('/conversations', conversationsRoute(engine, memory));

  app.route('/memory', memoryRoute(hamStore));

  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  app.onError((err, c) => {
    logger.error({ err }, 'Unhandled server error');
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
