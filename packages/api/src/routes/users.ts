import {
  InviteUserRequestSchema,
  ListUsersQuerySchema,
  UpdateUserRequestSchema,
} from '@mc/contracts';
import { notFound } from '@mc/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { authenticate, requireActor } from '../auth.js';
import { validationError } from '../problem.js';

const IdParams = z.object({ id: z.uuid() });

/** A malformed id can never name a user, so it is a 404 rather than a validation error. */
function userId(params: unknown): string {
  const parsed = IdParams.safeParse(params);
  if (!parsed.success) throw notFound('User');
  return parsed.data.id;
}

export function userRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { services, accessTokens } = deps;
  const auth = { preHandler: authenticate(accessTokens) };

  app.get('/v1/me', auth, async (request) => services.users.me(requireActor(request)));

  app.get('/v1/users', auth, async (request) => {
    const parsed = ListUsersQuerySchema.safeParse(request.query);
    if (!parsed.success) throw validationError(parsed.error);
    return services.users.list(requireActor(request), parsed.data);
  });

  app.post('/v1/users', auth, async (request, reply) => {
    const parsed = InviteUserRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    const result = await services.users.invite(requireActor(request), parsed.data);
    return reply.code(201).send(result);
  });

  app.patch('/v1/users/:id', auth, async (request) => {
    const parsed = UpdateUserRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    return services.users.update(requireActor(request), userId(request.params), parsed.data);
  });

  app.post('/v1/users/:id/invites', auth, async (request, reply) => {
    const invite = await services.users.reinvite(requireActor(request), userId(request.params));
    return reply.code(201).send(invite);
  });
}
