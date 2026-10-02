import {
  AddUnavailabilityRequestSchema,
  CreateSkillRequestSchema,
  ListAuditQuerySchema,
  ListCrewQuerySchema,
  ListSkillsQuerySchema,
  SetCrewSkillRequestSchema,
  UpdateOrgSettingsRequestSchema,
  UpdateSkillRequestSchema,
} from '@mc/contracts';
import { notFound } from '@mc/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { authenticate, requireActor } from '../auth.js';
import { validationError } from '../problem.js';

const Id = z.uuid();

/** A malformed id can never name anything, so it is a 404 rather than a validation error. */
function id(value: unknown, what: string): string {
  const parsed = Id.safeParse(value);
  if (!parsed.success) throw notFound(what);
  return parsed.data;
}

export function orgCrewRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { services, accessTokens } = deps;
  const auth = { preHandler: authenticate(accessTokens) };
  const params = (request: { params: unknown }) => request.params as Record<string, string>;

  // Organisation settings (Directors write, everyone reads)
  app.get('/v1/org/settings', auth, async (request) =>
    services.settings.get(requireActor(request)),
  );

  app.patch('/v1/org/settings', auth, async (request) => {
    const parsed = UpdateOrgSettingsRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    return services.settings.update(requireActor(request), parsed.data);
  });

  // Skill catalogue
  app.get('/v1/skills', auth, async (request) => {
    const parsed = ListSkillsQuerySchema.safeParse(request.query);
    if (!parsed.success) throw validationError(parsed.error);
    return services.skills.list(requireActor(request), parsed.data);
  });

  app.post('/v1/skills', auth, async (request, reply) => {
    const parsed = CreateSkillRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    return reply.code(201).send(await services.skills.create(requireActor(request), parsed.data));
  });

  app.patch('/v1/skills/:id', auth, async (request) => {
    const parsed = UpdateSkillRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    return services.skills.rename(
      requireActor(request),
      id(params(request).id, 'Skill'),
      parsed.data,
    );
  });

  // Crew profiles
  app.get('/v1/crew', auth, async (request) => {
    const parsed = ListCrewQuerySchema.safeParse(request.query);
    if (!parsed.success) throw validationError(parsed.error);
    return services.crew.list(requireActor(request), parsed.data);
  });

  app.get('/v1/crew/:id', auth, async (request) =>
    services.crew.get(requireActor(request), id(params(request).id, 'Crew member')),
  );

  app.put('/v1/crew/me/skills/:skillId', auth, async (request) => {
    const parsed = SetCrewSkillRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    return services.crew.setSkill(
      requireActor(request),
      id(params(request).skillId, 'Skill'),
      parsed.data.level,
    );
  });

  app.delete('/v1/crew/me/skills/:skillId', auth, async (request, reply) => {
    await services.crew.removeSkill(requireActor(request), id(params(request).skillId, 'Skill'));
    return reply.code(204).send();
  });

  app.post('/v1/crew/me/unavailability', auth, async (request, reply) => {
    const parsed = AddUnavailabilityRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    return reply
      .code(201)
      .send(await services.crew.addUnavailability(requireActor(request), parsed.data));
  });

  app.delete('/v1/crew/me/unavailability/:id', auth, async (request, reply) => {
    await services.crew.removeUnavailability(
      requireActor(request),
      id(params(request).id, 'Unavailability range'),
    );
    return reply.code(204).send();
  });

  // Audit log (Directors)
  app.get('/v1/audit', auth, async (request) => {
    const parsed = ListAuditQuerySchema.safeParse(request.query);
    if (!parsed.success) throw validationError(parsed.error);
    return services.auditLog.list(requireActor(request), parsed.data);
  });
}
