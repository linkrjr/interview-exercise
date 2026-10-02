import { z } from 'zod';

export const RoleSchema = z.enum(['director', 'lead', 'crew']);
export type Role = z.infer<typeof RoleSchema>;
