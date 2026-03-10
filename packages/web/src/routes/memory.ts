import { Hono } from 'hono';
import type { TieredStore } from '@agent-os/core';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function memoryRoute(hamStore: TieredStore): Hono {
  const app = new Hono();

  app.get('/chunks', (c) => {
    try {
      const chunks = hamStore.listChunks();
      return c.json({ chunks });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get('/chunks/:id', (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'Invalid chunk ID format' }, 400);
    }
    try {
      const chunk = hamStore.getChunk(id);
      if (!chunk) {
        return c.json({ error: 'Chunk not found' }, 404);
      }
      return c.json({ chunk });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
