import { systemClock, type Clock } from '@mc/core';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * In-memory sliding-window counter: at most `max` hits per key within `windowMs`. State is per
 * process, so with several API instances each one counts separately (DESIGN.md §12 decision).
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private sinceSweep = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Records a hit and says whether it is within the limit. Blocked hits are not counted. */
  hit(key: string): RateLimitResult {
    const now = this.clock.now().getTime();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    let result: RateLimitResult;
    if (recent.length >= this.max) {
      const retryAfterMs = recent[0]! + this.windowMs - now;
      result = { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    } else {
      recent.push(now);
      result = { allowed: true, retryAfterSeconds: 0 };
    }
    this.hits.set(key, recent);
    if (++this.sinceSweep >= 1000) this.sweep(cutoff);
    return result;
  }

  /** Drops keys with no hits left in the window, so memory follows the active keys. */
  private sweep(cutoff: number): void {
    this.sinceSweep = 0;
    for (const [key, times] of this.hits) {
      if (times.every((t) => t <= cutoff)) this.hits.delete(key);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}
