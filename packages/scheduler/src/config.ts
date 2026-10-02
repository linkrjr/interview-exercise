import { z } from 'zod';

const EnvSchema = z.object({
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL_TENANT: z.string().min(1),
  DATABASE_URL_SCHEDULER: z.string().min(1),
  SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(300),
});

export interface SchedulerConfig {
  logLevel: string;
  tenantUrl: string;
  schedulerUrl: string;
  intervalMs: number;
}

/** Validates the environment and fails with every problem at once. */
export function loadSchedulerConfig(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const e = parsed.data;
  return {
    logLevel: e.LOG_LEVEL,
    tenantUrl: e.DATABASE_URL_TENANT,
    schedulerUrl: e.DATABASE_URL_SCHEDULER,
    intervalMs: e.SCHEDULER_INTERVAL_SECONDS * 1000,
  };
}
