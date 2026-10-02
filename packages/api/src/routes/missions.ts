import {
  AppError,
  CreateMissionRequestSchema,
  ErrorCodes,
  ListAssignmentsQuerySchema,
  ListMissionsQuerySchema,
  ListNotificationsQuerySchema,
  SetCrewRequestSchema,
  SetRequirementsRequestSchema,
  TransitionRequestSchema,
  UpdateMissionRequestSchema,
} from '@mc/contracts';
import { notFound } from '@mc/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { authenticate, requireActor } from '../auth.js';
import { validationError } from '../problem.js';

const Id = z.uuid();

/** A malformed id can never name anything, so it is a 404 rather than a validation error. */
function id(request: FastifyRequest, what: string, key = 'id'): string {
  const parsed = Id.safeParse((request.params as Record<string, string>)[key]);
  if (!parsed.success) throw notFound(what);
  return parsed.data;
}

/**
 * The mission version the caller last saw, from `If-Match` (DESIGN.md §13): `3`, `"3"` or `W/"3"`.
 * Every change to a mission requires it; a stale one is a 412, a missing one a 428.
 */
function ifMatch(request: FastifyRequest): number {
  const header = request.headers['if-match'];
  if (header === undefined) {
    throw new AppError(
      ErrorCodes.IF_MATCH_REQUIRED,
      428,
      'Send the mission version you last saw in the If-Match header',
    );
  }
  const match = /^\s*(?:W\/)?"?(\d+)"?\s*$/.exec(header);
  if (!match) {
    throw new AppError(
      ErrorCodes.VALIDATION_FAILED,
      400,
      'The If-Match header is not a mission version',
      {
        errors: [
          { field: 'If-Match', code: 'invalid', message: 'Expected the mission version, e.g. "3"' },
        ],
      },
    );
  }
  return Number(match[1]);
}

/** Staff views carry the version; it is also sent as the `ETag`. */
function withEtag<T>(reply: FastifyReply, mission: T): T {
  const version = (mission as { version?: unknown }).version;
  if (typeof version === 'number') reply.header('ETag', `"${version}"`);
  return mission;
}

export function missionRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { services, accessTokens } = deps;
  const auth = { preHandler: authenticate(accessTokens) };

  app.get('/v1/missions', auth, async (request) => {
    const parsed = ListMissionsQuerySchema.safeParse(request.query);
    if (!parsed.success) throw validationError(parsed.error);
    return services.missions.list(requireActor(request), parsed.data);
  });

  app.post('/v1/missions', auth, async (request, reply) => {
    const parsed = CreateMissionRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    const mission = await services.missions.create(requireActor(request), parsed.data);
    return reply.code(201).send(withEtag(reply, mission));
  });

  app.get('/v1/missions/:id', auth, async (request, reply) =>
    withEtag(reply, await services.missions.get(requireActor(request), id(request, 'Mission'))),
  );

  app.patch('/v1/missions/:id', auth, async (request, reply) => {
    const parsed = UpdateMissionRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    const version = ifMatch(request);
    return withEtag(
      reply,
      await services.missions.update(
        requireActor(request),
        id(request, 'Mission'),
        parsed.data,
        version,
      ),
    );
  });

  app.put('/v1/missions/:id/requirements', auth, async (request, reply) => {
    const parsed = SetRequirementsRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    const version = ifMatch(request);
    return withEtag(
      reply,
      await services.missions.setRequirements(
        requireActor(request),
        id(request, 'Mission'),
        parsed.data,
        version,
      ),
    );
  });

  app.put('/v1/missions/:id/crew', auth, async (request, reply) => {
    const parsed = SetCrewRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    const version = ifMatch(request);
    return withEtag(
      reply,
      await services.missions.replaceCrew(
        requireActor(request),
        id(request, 'Mission'),
        parsed.data.crewMemberIds,
        { version },
      ),
    );
  });

  app.post('/v1/missions/:id/transitions', auth, async (request, reply) => {
    const parsed = TransitionRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    const version = ifMatch(request);
    return withEtag(
      reply,
      await services.missions.transition(
        requireActor(request),
        id(request, 'Mission'),
        parsed.data,
        version,
      ),
    );
  });

  // Assignments of the signed-in Crew Member
  app.get('/v1/assignments/me', auth, async (request) => {
    const parsed = ListAssignmentsQuerySchema.safeParse(request.query);
    if (!parsed.success) throw validationError(parsed.error);
    return services.assignments.listMine(requireActor(request), parsed.data);
  });

  app.post('/v1/assignments/:id/acknowledge', auth, async (request) =>
    services.assignments.acknowledge(requireActor(request), id(request, 'Assignment')),
  );

  // In-app inbox
  app.get('/v1/notifications', auth, async (request) => {
    const parsed = ListNotificationsQuerySchema.safeParse(request.query);
    if (!parsed.success) throw validationError(parsed.error);
    return services.notifications.list(requireActor(request), parsed.data);
  });

  app.post('/v1/notifications/:id/read', auth, async (request) =>
    services.notifications.markRead(requireActor(request), id(request, 'Notification')),
  );
}
