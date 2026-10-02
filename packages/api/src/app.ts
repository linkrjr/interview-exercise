import { AppError, ErrorCodes } from '@mc/contracts';
import type { AccessTokenService, Clock, Services } from '@mc/core';
import { systemClock } from '@mc/core';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { problemBody, PROBLEM_CONTENT_TYPE } from './problem.js';
import { authRoutes } from './routes/auth.js';
import { openApiRoutes } from './routes/openapi.js';
import { testRoutes, type TestSupport } from './routes/test-support.js';
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
  /**
   * The test-only endpoints (`/v1/test/*`). Pass it only in non-production builds: without it the
   * routes do not exist (DESIGN.md §16).
   */
  testSupport?: TestSupport;
}

export interface BuildAppOptions extends Omit<AppDeps, 'clock'> {
  clock?: Clock;
  logger?: FastifyServerOptions['logger'];
  trustProxy?: boolean;
  /** Largest accepted request body in bytes (default 1 MiB, Fastify's own). */
  bodyLimit?: number;
  /** `Strict-Transport-Security` max-age in seconds; 0 omits the header (default one year). */
  hstsMaxAgeSeconds?: number;
  /** Called with every route as it is registered (the OpenAPI coverage test uses it). */
  onRoute?: (route: { method: string; url: string }) => void;
}

/**
 * What may be logged about an unexpected error. Driver errors carry the failing statement with its
 * parameters, and Postgres' `detail` quotes the offending row, so neither the message nor the
 * driver's extra fields are logged (DESIGN.md §18: no PII in logs). The stack frames are kept,
 * without its first line (which repeats the message).
 */
export function safeError(error: unknown): { name: string; code?: string; frames: string[] } {
  const e = (error ?? {}) as {
    name?: unknown;
    code?: unknown;
    cause?: { code?: unknown };
    stack?: unknown;
  };
  const code = typeof e.code === 'string' ? e.code : e.cause?.code;
  return {
    name: typeof e.name === 'string' ? e.name : typeof error,
    ...(typeof code === 'string' ? { code } : {}),
    frames:
      typeof e.stack === 'string'
        ? e.stack
            .split('\n')
            .filter((line) => line.trimStart().startsWith('at '))
            .slice(0, 12)
        : [],
  };
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
    bodyLimit: options.bodyLimit ?? 1_048_576,
  });

  if (options.onRoute) {
    const report = options.onRoute;
    app.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) report({ method, url: route.url });
    });
  }

  // TLS ends at the load balancer (DESIGN.md §18); HSTS tells browsers never to try plain HTTP, and
  // the rest keep an API response from ever being rendered, framed or cached as a page.
  const hsts = options.hstsMaxAgeSeconds ?? 31_536_000;
  app.addHook('onRequest', async (_request, reply) => {
    if (hsts > 0) reply.header('Strict-Transport-Security', `max-age=${hsts}; includeSubDomains`);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('Cache-Control', 'no-store');
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
        request.log.error({ error: safeError(error) }, 'unhandled error');
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
  openApiRoutes(app);
  if (deps.testSupport) testRoutes(app, deps, deps.testSupport);
  return app;
}
