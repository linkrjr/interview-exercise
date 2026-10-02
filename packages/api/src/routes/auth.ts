import {
  AcceptInviteRequestSchema,
  AppError,
  ErrorCodes,
  LoginRequestSchema,
  LogoutRequestSchema,
  RefreshRequestSchema,
} from '@mc/contracts';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { validationError } from '../problem.js';
import { SlidingWindowLimiter } from '../rate-limit.js';

export function authRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { identity, loginRate, clock } = deps;
  const byEmail = new SlidingWindowLimiter(loginRate.emailMax, loginRate.windowMs, clock);
  const byIp = new SlidingWindowLimiter(loginRate.ipMax, loginRate.windowMs, clock);

  app.post('/v1/auth/login', async (request, reply) => {
    const parsed = LoginRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);

    // Both counters are always charged, so a blocked key cannot be probed through the other.
    const ip = byIp.hit(request.ip);
    const email = byEmail.hit(parsed.data.email.toLowerCase());
    if (!ip.allowed || !email.allowed) {
      const retryAfter = Math.max(ip.retryAfterSeconds, email.retryAfterSeconds);
      reply.header('Retry-After', String(retryAfter));
      throw new AppError(ErrorCodes.RATE_LIMITED, 429, 'Too many login attempts, try again later', {
        retryAfterSeconds: retryAfter,
      });
    }
    return identity.auth.login(parsed.data);
  });

  app.post('/v1/auth/refresh', async (request) => {
    const parsed = RefreshRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    return identity.auth.refresh(parsed.data.refreshToken);
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const parsed = LogoutRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    await identity.auth.logout(parsed.data.refreshToken);
    return reply.code(204).send();
  });

  app.post('/v1/auth/accept-invite', async (request) => {
    const parsed = AcceptInviteRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    return identity.auth.acceptInvite(parsed.data);
  });
}
