import { Hono } from 'hono';
export function healthRoute() {
    const app = new Hono();
    app.get('/', (c) => c.json({
        status: 'ok',
        uptime: process.uptime(),
        ts: new Date().toISOString(),
        version: '0.2.0',
    }));
    return app;
}
//# sourceMappingURL=health.js.map