import { CreateOrganisationRequestSchema, ReissueInviteRequestSchema } from '@mc/contracts';
import { notFound } from '@mc/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { authenticateOperator } from '../auth.js';
import { validationError } from '../problem.js';

const OrgParams = z.object({ orgId: z.uuid() });

/** Operator provisioning: no organisation, no tenant context (DESIGN.md §6, §11). */
export function platformRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { identity, operatorToken } = deps;
  const operator = { preHandler: authenticateOperator(operatorToken) };

  app.post('/v1/platform/organisations', operator, async (request, reply) => {
    const parsed = CreateOrganisationRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    const created = await identity.platform.createOrganisation(parsed.data);
    return reply.code(201).send(created);
  });

  app.post('/v1/platform/organisations/:orgId/invites', operator, async (request, reply) => {
    const params = OrgParams.safeParse(request.params);
    if (!params.success) throw notFound('Organisation');
    const parsed = ReissueInviteRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    const result = await identity.platform.reissueInvite(params.data.orgId, parsed.data.userId);
    return reply.code(201).send(result);
  });
}
