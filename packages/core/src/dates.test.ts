import { describe, expect, it } from 'vitest';
import { todayIn } from './dates.js';

describe('todayIn', () => {
  const instant = new Date('2026-10-02T10:00:00Z');

  it('gives the date in the given time zone', () => {
    expect(todayIn(instant, 'UTC')).toBe('2026-10-02');
    expect(todayIn(instant, 'Europe/London')).toBe('2026-10-02');
    expect(todayIn(instant, 'Pacific/Kiritimati')).toBe('2026-10-03'); // UTC+14
    expect(todayIn(instant, 'Pacific/Pago_Pago')).toBe('2026-10-01'); // UTC-11
  });

  it('follows the local midnight, including daylight saving', () => {
    // London is UTC+1 in October 2026 until the 25th.
    expect(todayIn(new Date('2026-10-02T22:59:59Z'), 'Europe/London')).toBe('2026-10-02');
    expect(todayIn(new Date('2026-10-02T23:00:00Z'), 'Europe/London')).toBe('2026-10-03');
    expect(todayIn(new Date('2026-12-02T23:59:59Z'), 'Europe/London')).toBe('2026-12-02');
    expect(todayIn(new Date('2026-12-03T00:00:00Z'), 'Europe/London')).toBe('2026-12-03');
  });

  it('is zero-padded ISO, comparable as a string', () => {
    expect(todayIn(new Date('2026-01-05T12:00:00Z'), 'UTC')).toBe('2026-01-05');
    expect(todayIn(new Date('2026-01-05T12:00:00Z'), 'UTC') < '2026-01-06').toBe(true);
  });
});
