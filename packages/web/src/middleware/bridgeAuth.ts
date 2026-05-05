/**
 * Bridge auth middleware — validates Bearer token against the bridge secret.
 * Returns 401 on mismatch so only the local VS Code extension (which reads
 * ~/.agent-os/.bridge-secret) can reach bridge endpoints.
 */

import type { MiddlewareHandler } from 'hono';
import { getBridgeSecret } from '../bridge-secret.js';

export function bridgeAuth(): MiddlewareHandler {
  const secret = getBridgeSecret();

  return async (c, next) => {
    const auth = c.req.header('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    if (!token || token !== secret) {
      return c.json({ error: 'Unauthorized — invalid or missing bridge secret' }, 401);
    }

    await next();
  };
}
