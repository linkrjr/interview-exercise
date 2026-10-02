import type { PassResult, SchedulerDeps } from './run-pass.js';
import { runPass } from './run-pass.js';

export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface RunningScheduler {
  /** Stops scheduling and waits for a pass in progress to finish. */
  stop(): Promise<void>;
}

/**
 * Runs a pass immediately and then every `intervalMs` (DESIGN.md §16). A pass starts only after the
 * previous one has finished, and one that throws (the database being down, say) is logged and the
 * loop carries on.
 */
export function startScheduler(
  deps: SchedulerDeps,
  options: { intervalMs?: number; pass?: (deps: SchedulerDeps) => Promise<PassResult> } = {},
): RunningScheduler {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const pass = options.pass ?? runPass;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let current: Promise<void> = Promise.resolve();

  const tick = async () => {
    try {
      await pass(deps);
    } catch (error) {
      deps.logger.error(
        { error: { name: error instanceof Error ? error.name : typeof error } },
        'scheduler pass failed',
      );
    }
    if (!stopped) timer = setTimeout(() => void (current = tick()), intervalMs);
  };
  current = tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
  };
}
