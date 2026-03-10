import type { MiddlewareHandler } from 'hono';
interface RateLimitOptions {
    windowMs: number;
    max: number;
}
export declare function rateLimit({ windowMs, max }?: Partial<RateLimitOptions>): MiddlewareHandler;
export {};
//# sourceMappingURL=rateLimit.d.ts.map