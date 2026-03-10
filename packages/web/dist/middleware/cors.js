import { cors } from 'hono/cors';
export function createCors(origin) {
    return cors({
        origin,
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
        exposeHeaders: ['X-Conversation-Id'],
        maxAge: 86400,
        credentials: origin !== '*',
    });
}
//# sourceMappingURL=cors.js.map