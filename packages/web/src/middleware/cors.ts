import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

export function createCors(origin: string): MiddlewareHandler {
  return cors({
    origin,
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['X-Conversation-Id'],
    maxAge: 86400,
    credentials: origin !== '*',
  });
}
