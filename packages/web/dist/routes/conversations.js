import { Hono } from 'hono';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function conversationsRoute(engine) {
    const app = new Hono();
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
//# sourceMappingURL=conversations.js.map