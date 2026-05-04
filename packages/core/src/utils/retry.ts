import { randomInt } from 'node:crypto';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

/** Compute jittered exponential backoff delay (ms). Decorrelates concurrent retries. */
export function jitteredBackoffMs(
  attempt: number,
  baseDelayMs = 5_000,
  maxDelayMs = 120_000,
  jitterRatio = 0.5,
): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = exponent >= 63 ? maxDelayMs : Math.min(baseDelayMs * Math.pow(2, exponent), maxDelayMs);
  const jitter = (randomInt(0, 1_000_000) / 1_000_000) * jitterRatio * raw;
  return raw + jitter;
}

function isRateLimitOrServer(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('rate limit') || msg.includes('429') || msg.includes('529') || msg.includes('503') || msg.includes('overloaded')) return true;
  }
  const status = (err as { status?: number })?.status;
  if (typeof status === 'number' && (status === 429 || status === 503 || status === 529)) return true;
  return false;
}

/** Retry an async function with jittered exponential backoff. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 4,
    baseDelayMs = 5_000,
    maxDelayMs = 120_000,
    jitterRatio = 0.5,
    shouldRetry = isRateLimitOrServer,
  } = options;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      if (attempt === maxAttempts || !shouldRetry(err, attempt)) throw err;
      const delay = jitteredBackoffMs(attempt, baseDelayMs, maxDelayMs, jitterRatio);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}
