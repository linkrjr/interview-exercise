import { z } from 'zod';
import { RoleSchema } from './role.js';

/**
 * Bodies of the development and test-only endpoints (`/v1/test/*`). They exist only in non-production
 * builds and are deliberately not part of the OpenAPI document (DESIGN.md §16).
 */
export const SeedRequestSchema = z.object({ scenario: z.enum(['demo']) });
export type SeedRequest = z.infer<typeof SeedRequestSchema>;

export const SeedResponseSchema = z.object({
  scenario: z.enum(['demo']),
  /** Every seeded user has this password. */
  password: z.string(),
  organisations: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      timeZone: z.string(),
      users: z.array(z.object({ role: RoleSchema, name: z.string(), email: z.string() })),
      missions: z.array(z.object({ name: z.string(), status: z.string() })),
    }),
  ),
});
export type SeedResponse = z.infer<typeof SeedResponseSchema>;

export const RunSchedulerRequestSchema = z.object({
  /** The day the pass pretends it is, `YYYY-MM-DD`. */
  today: z.iso.date(),
});
export type RunSchedulerRequest = z.infer<typeof RunSchedulerRequestSchema>;

export const RunSchedulerResponseSchema = z.object({
  organisations: z.array(
    z.object({
      organisationId: z.uuid(),
      status: z.enum(['ok', 'failed']),
      expired: z.number().int().optional(),
      activated: z.number().int().optional(),
      completed: z.number().int().optional(),
      alertWritten: z.boolean().optional(),
    }),
  ),
  alertsPurged: z.number().int(),
});
export type RunSchedulerResponse = z.infer<typeof RunSchedulerResponseSchema>;
