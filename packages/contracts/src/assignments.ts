import { z } from 'zod';
import { MAX_PAGE_LIMIT } from './page.js';
import { MissionStatusSchema } from './missions.js';

export const AssignmentSchema = z.object({
  id: z.uuid(),
  acknowledgedAt: z.iso.datetime().nullable(),
  mission: z.object({
    id: z.uuid(),
    name: z.string(),
    description: z.string(),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    status: MissionStatusSchema,
  }),
});
export type Assignment = z.infer<typeof AssignmentSchema>;

export const ListAssignmentsQuerySchema = z.object({
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(25),
});
export type ListAssignmentsQuery = z.infer<typeof ListAssignmentsQuerySchema>;
