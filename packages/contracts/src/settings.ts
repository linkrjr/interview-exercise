import { z } from 'zod';
import { TimeZoneSchema } from './timezone.js';

export const MAX_UPCOMING_MISSIONS_MIN = 1;
export const MAX_UPCOMING_MISSIONS_MAX = 20;

export const OrgSettingsSchema = z.object({
  timeZone: z.string(),
  maxUpcomingMissions: z.number().int(),
});
export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

export const UpdateOrgSettingsRequestSchema = z
  .object({
    timeZone: TimeZoneSchema.optional(),
    maxUpcomingMissions: z
      .number()
      .int()
      .min(MAX_UPCOMING_MISSIONS_MIN)
      .max(MAX_UPCOMING_MISSIONS_MAX)
      .optional(),
  })
  .refine((v) => v.timeZone !== undefined || v.maxUpcomingMissions !== undefined, {
    message: 'Provide a time zone or a workload cap',
  });
export type UpdateOrgSettingsRequest = z.infer<typeof UpdateOrgSettingsRequestSchema>;
