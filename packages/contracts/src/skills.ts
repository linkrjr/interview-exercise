import { z } from 'zod';
import { MAX_PAGE_LIMIT } from './page.js';

export const SKILL_NAME_MAX_LENGTH = 100;

/** Names are trimmed, internal whitespace is collapsed, and they are unique per organisation, ignoring case. */
export const SkillNameSchema = z
  .string()
  .transform((v) => v.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1).max(SKILL_NAME_MAX_LENGTH));

export const SkillSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
});
export type Skill = z.infer<typeof SkillSchema>;

export const CreateSkillRequestSchema = z.object({ name: SkillNameSchema });
export type CreateSkillRequest = z.infer<typeof CreateSkillRequestSchema>;

export const UpdateSkillRequestSchema = CreateSkillRequestSchema;
export type UpdateSkillRequest = CreateSkillRequest;

export const ListSkillsQuerySchema = z.object({
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(50),
});
export type ListSkillsQuery = z.infer<typeof ListSkillsQuerySchema>;
