import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startScheduler } from './loop.js';
import { silentSchedulerLogger } from './logger.js';
import type { PassResult, SchedulerDeps } from './run-pass.js';

const deps = { logger: silentSchedulerLogger } as unknown as SchedulerDeps;
const ran: PassResult = { ran: true, organisations: [], alertsPurged: 0 };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startScheduler', () => {
  it('runs a pass at start-up and then once per interval', async () => {
    const pass = vi.fn(async () => ran);
    const scheduler = startScheduler(deps, { intervalMs: 1000, pass });
    await vi.advanceTimersByTimeAsync(0);
    expect(pass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pass).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(pass).toHaveBeenCalledTimes(4);
    await scheduler.stop();
  });

  it('keeps going after a pass throws', async () => {
    const pass = vi
      .fn<() => Promise<PassResult>>()
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue(ran);
    const scheduler = startScheduler(deps, { intervalMs: 1000, pass });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pass).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('never starts a pass while the previous one is still running', async () => {
    let release!: () => void;
    const pass = vi.fn(
      () =>
        new Promise<PassResult>((resolve) => {
          release = () => resolve(ran);
        }),
    );
    const scheduler = startScheduler(deps, { intervalMs: 1000, pass });
    await vi.advanceTimersByTimeAsync(5000);
    expect(pass).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pass).toHaveBeenCalledTimes(2);
    release();
    await scheduler.stop();
  });

  it('stops scheduling and waits for a pass in progress', async () => {
    let release!: () => void;
    let finished = false;
    const pass = vi.fn(
      () =>
        new Promise<PassResult>((resolve) => {
          release = () => {
            finished = true;
            resolve(ran);
          };
        }),
    );
    const scheduler = startScheduler(deps, { intervalMs: 1000, pass });
    const stopping = scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(finished).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pass).toHaveBeenCalledTimes(1);
  });
});
