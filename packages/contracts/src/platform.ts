import { z } from 'zod';
import { EmailSchema } from './auth.js';
import { InviteSchema } from './users.js';

export const CreateOrganisationRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  directorEmail: EmailSchema,
});
export type CreateOrganisationRequest = z.infer<typeof CreateOrganisationRequestSchema>;

export const CreateOrganisationResponseSchema = z.object({
  organisationId: z.uuid(),
  directorUserId: z.uuid(),
  invite: InviteSchema,
});
export type CreateOrganisationResponse = z.infer<typeof CreateOrganisationResponseSchema>;

/** The operator names the invited user (e.g. the `directorUserId` it was given). */
export const ReissueInviteRequestSchema = z.object({ userId: z.uuid() });
export type ReissueInviteRequest = z.infer<typeof ReissueInviteRequestSchema>;

export const ReissueInviteResponseSchema = z.object({ invite: InviteSchema });
export type ReissueInviteResponse = z.infer<typeof ReissueInviteResponseSchema>;
