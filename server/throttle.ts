interface Bucket {
  windowStartMs: number;
  count: number;
  lastSeenMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

const buckets = new Map<string, Bucket>();

const SWEEP_EVERY_CALLS = 200;
const STALE_BUCKET_TTL_MS = 5 * 60 * 1000;
let callsSinceSweep = 0;

function maybeSweep(nowMs: number): void {
  callsSinceSweep++;
  if (callsSinceSweep < SWEEP_EVERY_CALLS) return;
  callsSinceSweep = 0;

  for (const [key, bucket] of buckets) {
    if (nowMs - bucket.lastSeenMs > STALE_BUCKET_TTL_MS) {
      buckets.delete(key);
    }
  }
}

/**
 * Fixed-window per-key rate limiter.
 * Returns whether a request is allowed and how long to wait when denied.
 */
export function checkRateLimit(
  scope: string,
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const nowMs = Date.now();
  maybeSweep(nowMs);

  const mapKey = `${scope}:${key}`;
  const existing = buckets.get(mapKey);

  if (!existing || nowMs - existing.windowStartMs >= windowMs) {
    buckets.set(mapKey, {
      windowStartMs: nowMs,
      count: 1,
      lastSeenMs: nowMs,
    });
    return { allowed: true, retryAfterMs: 0 };
  }

  existing.lastSeenMs = nowMs;

  if (existing.count >= limit) {
    const retryAfterMs = Math.max(0, windowMs - (nowMs - existing.windowStartMs));
    return { allowed: false, retryAfterMs };
  }

  existing.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}
