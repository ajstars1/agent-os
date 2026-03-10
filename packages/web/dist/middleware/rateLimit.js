export function rateLimit({ windowMs = 60_000, max = 60 } = {}) {
    const windows = new Map();
    // Prune stale entries every 5 minutes
    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of windows) {
            if (now - entry.windowStart > windowMs * 2)
                windows.delete(key);
        }
    }, 5 * 60_000).unref();
    return async (c, next) => {
        const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
            c.req.header('x-real-ip') ??
            'unknown';
        const now = Date.now();
        const entry = windows.get(ip);
        if (!entry || now - entry.windowStart > windowMs) {
            windows.set(ip, { count: 1, windowStart: now });
            await next();
            return;
        }
        if (entry.count >= max) {
            const retryAfter = Math.ceil((windowMs - (now - entry.windowStart)) / 1000);
            c.res = c.newResponse(JSON.stringify({ error: 'Too many requests', retryAfterSeconds: retryAfter }), 429, {
                'Content-Type': 'application/json',
                'Retry-After': String(retryAfter),
            });
            return;
        }
        entry.count++;
        await next();
    };
}
//# sourceMappingURL=rateLimit.js.map