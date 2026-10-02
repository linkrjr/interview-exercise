import type { Logger } from '@mc/core';

export interface SchedulerLogger extends Logger {
  error(obj: object, msg?: string): void;
}

const LEVELS = { error: 50, warn: 40, info: 30 } as const;
const THRESHOLDS: Record<string, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
  silent: 100,
};

/**
 * One JSON object per line on stdout, in the same shape Fastify's logger writes (numeric level,
 * epoch-millisecond time, `msg`), so the API and the scheduler logs can be read together.
 */
export function createLogger(
  level: string,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  now: () => number = Date.now,
): SchedulerLogger {
  const threshold = THRESHOLDS[level] ?? THRESHOLDS.info!;
  const log = (name: keyof typeof LEVELS) => (obj: object, msg?: string) => {
    if (LEVELS[name] < threshold) return;
    write(JSON.stringify({ level: LEVELS[name], time: now(), name: 'scheduler', ...obj, msg }));
  };
  return { info: log('info'), warn: log('warn'), error: log('error') };
}

export const silentSchedulerLogger: SchedulerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
