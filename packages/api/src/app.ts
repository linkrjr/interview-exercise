import { AppError, ErrorCodes } from '@mc/contracts';
import type { AccessTokenService, Clock, Services } from '@mc/core';
import { systemClock } from '@mc/core';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { problemBody, PROBLEM_CONTENT_TYPE } from './problem.js';
import { authRoutes } from './routes/auth.js';
import { missionRoutes } from './routes/missions.js';
import { orgCrewRoutes } from './routes/org-crew.js';
import { platformRoutes } from './routes/platform.js';
import { userRoutes } from './routes/users.js';

export interface AppDeps {
  services: Services;
  accessTokens: AccessTokenService;
  /** Static credential accepted only on `/v1/platform/*`. */
  operatorToken: string;
  loginRate: { emailMax: number; ipMax: number; windowMs: number };
  /**
   * Per-user limit on the matcher, the most expensive endpoint (DESIGN.md §18). Unset means no limit;
   * the number is a deployment setting (spec 06).
   */
  matchRate?: { max: number; windowMs: number };
  clock: Clock;
}

export interface BuildAppOptions extends Omit<AppDeps, 'clock'> {
  clock?: Clock;
  logger?: FastifyServerOptions['logger'];
  trustProxy?: boolean;
}

/** Logger options for the server: credentials never reach the logs. */
export function loggerOptions(level: string) {
  return { level, redact: ['req.headers.authorization'] };
}

const FASTIFY_STATUS_CODES: Record<string, [number, string]> = {
  FST_ERR_CTP_INVALID_JSON_BODY: [400, 'INVALID_JSON'],
  FST_ERR_CTP_EMPTY_JSON_BODY: [400, 'INVALID_JSON'],
  FST_ERR_CTP_INVALID_MEDIA_TYPE: [415, 'UNSUPPORTED_MEDIA_TYPE'],
  FST_ERR_CTP_BODY_TOO_LARGE: [413, 'PAYLOAD_TOO_LARGE'],
};

/** Builds the Fastify application. Authorisation lives in the core services; routes only parse and delegate. */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const deps: AppDeps = { ...options, clock: options.clock ?? systemClock };
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.trustProxy ?? false,
  });

  app.setErrorHandler((error, request, reply) => {
    let problem: AppError;
    if (error instanceof AppError) {
      problem = error;
    } else {
      const mapped =
        typeof (error as { code?: unknown }).code === 'string'
          ? FASTIFY_STATUS_CODES[(error as { code: string }).code]
          : undefined;
      if (mapped) {
        problem = new AppError(mapped[1], mapped[0], 'The request could not be read');
      } else {
        request.log.error({ err: error }, 'unhandled error');
        problem = new AppError('INTERNAL_ERROR', 500, 'An unexpected error occurred');
      }
    }
    // Only a missing or invalid credential is a Bearer challenge; other 401s (a failed login,
    // a revoked refresh token) are not.
    if (problem.code === ErrorCodes.UNAUTHENTICATED) reply.header('WWW-Authenticate', 'Bearer');
    return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problemBody(problem));
  });

  app.setNotFoundHandler((_request, reply) =>
    reply
      .code(404)
      .type(PROBLEM_CONTENT_TYPE)
      .send(problemBody(new AppError(ErrorCodes.NOT_FOUND, 404, 'Route not found'))),
  );

  authRoutes(app, deps);
  userRoutes(app, deps);
  orgCrewRoutes(app, deps);
  missionRoutes(app, deps);
  platformRoutes(app, deps);
  return app;
}
