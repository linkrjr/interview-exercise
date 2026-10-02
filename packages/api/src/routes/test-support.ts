import {
  AppError,
  RunSchedulerRequestSchema,
  SeedRequestSchema,
  type RunSchedulerResponse,
  type SeedResponse,
} from '@mc/contracts';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { authenticateOperator } from '../auth.js';
import { validationError } from '../problem.js';

/**
 * What the test-only endpoints do. The server builds it only outside production, and `buildApp`
 * registers the routes only when it is given one, so a production build has no such routes.
 */
export interface TestSupport {
  /** Runs one scheduler pass as if `today` (`YYYY-MM-DD`) were the date in every organisation. */
  runScheduler(today: string): Promise<RunSchedulerResponse>;
  seed(scenario: 'demo'): Promise<SeedResponse>;
}

/** Operator-only helpers for the e2e suite and local development (DESIGN.md §16, §19). */
export function testRoutes(app: FastifyInstance, deps: AppDeps, support: TestSupport): void {
  const operator = { preHandler: authenticateOperator(deps.operatorToken) };

  app.post('/v1/test/scheduler/run', operator, async (request) => {
    const parsed = RunSchedulerRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    return support.runScheduler(parsed.data.today);
  });

  app.post('/v1/test/seed', operator, async (request) => {
    const parsed = SeedRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    try {
      return await support.seed(parsed.data.scenario);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'EMAIL_ALREADY_REGISTERED') {
        throw new AppError(
          'SEED_ALREADY_APPLIED',
          409,
          'The scenario’s users already exist. Start from an empty database (docker compose down -v).',
        );
      }
      throw error;
    }
  });
}
