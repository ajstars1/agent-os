import { Hono } from 'hono';
import { createCors } from './middleware/cors.js';
import { rateLimit } from './middleware/rateLimit.js';
import { healthRoute } from './routes/health.js';
import { chatRoute } from './routes/chat.js';
import { conversationsRoute } from './routes/conversations.js';
export function createServer(deps) {
    const { engine, agents, config, logger } = deps;
    const app = new Hono();
    app.use('*', createCors(config.WEB_CORS_ORIGIN));
    app.use('/chat/*', rateLimit({ windowMs: 60_000, max: 60 }));
    app.route('/health', healthRoute());
    app.route('/chat', chatRoute(engine, agents, logger));
    app.route('/conversations', conversationsRoute(engine));
    app.notFound((c) => c.json({ error: 'Not found' }, 404));
    app.onError((err, c) => {
        logger.error({ err }, 'Unhandled server error');
        return c.json({ error: 'Internal server error' }, 500);
    });
    return app;
}
//# sourceMappingURL=server.js.map