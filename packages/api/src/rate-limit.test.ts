import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from './rate-limit.js';

class Clock {
  constructor(public t = 1_000_000) {}
  now() {
    return new Date(this.t);
  }
}

describe('SlidingWindowLimiter', () => {
  it('allows up to max hits per window, then blocks with a retry delay', () => {
    const clock = new Clock();
    const limiter = new SlidingWindowLimiter(3, 60_000, clock);
    expect([1, 2, 3].map(() => limiter.hit('k').allowed)).toEqual([true, true, true]);
    clock.t += 10_000;
    expect(limiter.hit('k')).toEqual({ allowed: false, retryAfterSeconds: 50 });
  });

  it('slides: capacity returns as old hits leave the window', () => {
    const clock = new Clock();
    const limiter = new SlidingWindowLimiter(2, 60_000, clock);
    limiter.hit('k');
    clock.t += 30_000;
    limiter.hit('k');
    expect(limiter.hit('k').allowed).toBe(false);
    clock.t += 30_001; // the first hit is now 60.001 s old
    expect(limiter.hit('k').allowed).toBe(true);
    expect(limiter.hit('k').allowed).toBe(false);
  });

  it('does not count blocked hits, so waiting out the window is enough', () => {
    const clock = new Clock();
    const limiter = new SlidingWindowLimiter(1, 1000, clock);
    limiter.hit('k');
    for (let i = 0; i < 10; i++) limiter.hit('k');
    clock.t += 1001;
    expect(limiter.hit('k').allowed).toBe(true);
  });

  it('keeps keys independent', () => {
    const limiter = new SlidingWindowLimiter(1, 1000, new Clock());
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('b').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
  });

  it('always reports at least one second to wait', () => {
    const clock = new Clock();
    const limiter = new SlidingWindowLimiter(1, 1000, clock);
    limiter.hit('k');
    clock.t += 999;
    expect(limiter.hit('k').retryAfterSeconds).toBe(1);
  });

  it('forgets idle keys so memory follows the active ones', () => {
    const clock = new Clock();
    const limiter = new SlidingWindowLimiter(5, 1000, clock);
    for (let i = 0; i < 500; i++) limiter.hit(`idle-${i}`);
    clock.t += 5000;
    for (let i = 0; i < 600; i++) limiter.hit('busy');
    expect(limiter.size).toBe(1);
  });
});
