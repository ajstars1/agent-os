import { Hono } from 'hono';
import type { AgentEngine, SQLiteMemoryStore } from '@agent-os-core/core';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function conversationsRoute(engine: AgentEngine, memory: SQLiteMemoryStore): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    try {
      const limitParam = c.req.query('limit');
      const limit = limitParam ? Math.min(parseInt(limitParam, 10), 200) : 50;
      const conversations = memory.listConversations(limit);
      return c.json({ conversations });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get('/:id/messages', (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'Invalid conversation ID format' }, 400);
    }
    try {
      const messages = memory.getConversationMessages(id);
      return c.json({ messages });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'Invalid conversation ID format' }, 400);
    }
    engine.clearConversation(id);
    return c.json({ ok: true, conversationId: id });
  });

  return app;
}
