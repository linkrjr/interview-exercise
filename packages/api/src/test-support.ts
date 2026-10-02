import { AppError, type RunSchedulerResponse } from '@mc/contracts';
import { seedDemo, type AccessTokenService, type Clock, type Logger } from '@mc/core';
import type { Db } from '@mc/db';
import type { Solver } from '@mc/matcher';
import { createSchedulerDeps, runPass, type SchedulerLogger } from '@mc/scheduler';
import type { TestSupport } from './routes/test-support.js';

/** How long a manual pass waits for the real scheduler to let go of its lock. */
const LOCK_WAIT_MS = 5000;
const LOCK_RETRY_MS = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface TestSupportConfig {
  db: Db;
  /** Without it the scheduler pass cannot run (the API normally has no `app_scheduler` login). */
  hasSchedulerLogin: boolean;
  accessTokens: AccessTokenService;
  solver: Solver;
  logger: SchedulerLogger & Logger;
  clock: Clock;
}

/** The test-only endpoints' behaviour, built from the same pieces the real processes use. */
export function createTestSupport(config: TestSupportConfig): TestSupport {
  const { db, logger } = config;
  const scheduler = createSchedulerDeps({ db, logger, clock: config.clock });

  return {
    async runScheduler(today): Promise<RunSchedulerResponse> {
      if (!config.hasSchedulerLogin) {
        throw new AppError(
          'SCHEDULER_NOT_CONFIGURED',
          501,
          'Set DATABASE_URL_SCHEDULER to run the scheduler from the API',
        );
      }
      const deadline = Date.now() + LOCK_WAIT_MS;
      for (;;) {
        const result = await runPass(scheduler, { today });
        if (result.ran) {
          return {
            alertsPurged: result.alertsPurged,
            organisations: result.organisations.map((o) =>
              o.status === 'ok'
                ? { organisationId: o.organisationId, status: 'ok', ...o.result }
                : {
                    organisationId: o.organisationId,
                    status: 'failed',
                    alertWritten: o.alertWritten,
                  },
            ),
          };
        }
        if (Date.now() >= deadline) {
          throw new AppError('SCHEDULER_BUSY', 409, 'The scheduler is busy; try again');
        }
        await sleep(LOCK_RETRY_MS);
      }
    },

    seed: () =>
      seedDemo({
        db,
        accessTokens: config.accessTokens,
        solver: config.solver,
        logger,
        now: config.clock.now(),
      }),
  };
}
