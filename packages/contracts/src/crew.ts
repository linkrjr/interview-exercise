import { z } from 'zod';
import { MAX_PAGE_LIMIT } from './page.js';

export const SKILL_LEVEL_MIN = 1;
export const SKILL_LEVEL_MAX = 5;
export const UNAVAILABILITY_NOTE_MAX_LENGTH = 500;

const IsoDate = z.iso.date();

export const SkillLevelSchema = z.number().int().min(SKILL_LEVEL_MIN).max(SKILL_LEVEL_MAX);

export const CrewSkillSchema = z.object({
  skillId: z.uuid(),
  name: z.string(),
  level: SkillLevelSchema,
});
export type CrewSkill = z.infer<typeof CrewSkillSchema>;

export const SetCrewSkillRequestSchema = z.object({ level: SkillLevelSchema });
export type SetCrewSkillRequest = z.infer<typeof SetCrewSkillRequestSchema>;

/** An inclusive date range. The note is private: only the crew member sees it. */
export const UnavailabilitySchema = z.object({
  id: z.uuid(),
  from: IsoDate,
  to: IsoDate,
  note: z.string().nullable().optional(),
});
export type Unavailability = z.infer<typeof UnavailabilitySchema>;

export const AddUnavailabilityRequestSchema = z
  .object({
    from: IsoDate,
    to: IsoDate,
    note: z.string().trim().max(UNAVAILABILITY_NOTE_MAX_LENGTH).optional(),
  })
  .refine((v) => v.from <= v.to, {
    message: 'The end date must not be before the start date',
    path: ['to'],
  });
export type AddUnavailabilityRequest = z.infer<typeof AddUnavailabilityRequestSchema>;

export const CrewProfileSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  email: z.string(),
  skills: z.array(CrewSkillSchema),
  unavailability: z.array(UnavailabilitySchema),
  /** Live holds: missions the person is committed to (Pending approval, Approved, Active). */
  load: z.number().int().min(0),
});
export type CrewProfile = z.infer<typeof CrewProfileSchema>;

/** `skill=<skillId>:<minLevel>` (repeatable, all must hold) and `available=<from>:<to>`. */
const SkillFilter = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-5]$/i,
    'Expected <skillId>:<minLevel>, with a level from 1 to 5',
  );
const AvailableFilter = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$/, 'Expected <from>:<to> as YYYY-MM-DD dates')
  .refine((v) => {
    const [from, to] = v.split(':') as [string, string];
    return IsoDate.safeParse(from).success && IsoDate.safeParse(to).success && from <= to;
  }, 'Expected valid dates with from not after to');

export const ListCrewQuerySchema = z.object({
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(25),
  skill: z
    .union([SkillFilter, z.array(SkillFilter).max(20)])
    .optional()
    .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
  available: AvailableFilter.optional(),
});
export type ListCrewQuery = z.infer<typeof ListCrewQuerySchema>;
