import { z } from 'zod';
import { SkillLevelSchema } from './crew.js';
import { MAX_PAGE_LIMIT } from './page.js';

const IsoDate = z.iso.date();
const Uuid = z.uuid();

export const MISSION_NAME_MAX_LENGTH = 200;
export const MISSION_DESCRIPTION_MAX_LENGTH = 5000;
export const MAX_REQUIREMENTS = 50;
export const MAX_CREW = 200;
export const COMMENT_MAX_LENGTH = 1000;

export const MissionStatusSchema = z.enum([
  'draft',
  'crewing',
  'pending_approval',
  'approved',
  'active',
  'completed',
  'cancelled',
]);
export type MissionStatus = z.infer<typeof MissionStatusSchema>;

/** The actions a user can request on a mission. `activate`, `complete` and `expire` belong to the system. */
export const MissionActionSchema = z.enum([
  'start_crewing',
  'reopen',
  'submit',
  'withdraw',
  'approve',
  'reject',
  'cancel',
]);
export type MissionAction = z.infer<typeof MissionActionSchema>;

export const RequirementSchema = z.object({
  skillId: Uuid,
  skillName: z.string(),
  minLevel: SkillLevelSchema,
  count: z.number().int().min(1),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const CrewAssignmentSchema = z.object({
  assignmentId: Uuid,
  crewMemberId: Uuid,
  name: z.string().nullable(),
  email: z.string(),
  acknowledgedAt: z.iso.datetime().nullable(),
});
export type CrewAssignment = z.infer<typeof CrewAssignmentSchema>;

export const ApprovalDecisionSchema = z.object({
  id: Uuid,
  directorId: Uuid,
  decision: z.enum(['approved', 'rejected']),
  comment: z.string().nullable(),
  decidedAt: z.iso.datetime(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/**
 * Whether the tentative crew of a Crewing mission is submittable. Reasons are deliberately
 * generic (DESIGN.md §7.1), so why a named person is blocked is not exposed.
 */
export const CrewValidationSchema = z.object({
  valid: z.boolean(),
  assignmentIssues: z.array(
    z.object({ assignmentId: Uuid, crewMemberId: Uuid, code: z.literal('NOT_ELIGIBLE') }),
  ),
  unmetRequirements: z.array(
    z.object({
      skillId: Uuid,
      minLevel: SkillLevelSchema,
      required: z.number().int(),
      met: z.number().int(),
    }),
  ),
});
export type CrewValidation = z.infer<typeof CrewValidationSchema>;

/** What Directors and Leads see. */
export const MissionSchema = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string(),
  startDate: IsoDate,
  endDate: IsoDate,
  status: MissionStatusSchema,
  /** Optimistic-concurrency token: send it back in `If-Match` on every change. */
  version: z.number().int().min(1),
  leadId: Uuid,
  leadName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  requirements: z.array(RequirementSchema),
  crew: z.array(CrewAssignmentSchema),
  decisions: z.array(ApprovalDecisionSchema),
  /** Present only while the mission is Crewing. */
  crewValidation: CrewValidationSchema.optional(),
  /** The actions this user may take on this mission in its current state. */
  allowedActions: z.array(MissionActionSchema),
});
export type Mission = z.infer<typeof MissionSchema>;

/** A mission in a list, for Directors and Leads. */
export const MissionSummarySchema = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string(),
  startDate: IsoDate,
  endDate: IsoDate,
  status: MissionStatusSchema,
  version: z.number().int().min(1),
  leadId: Uuid,
  leadName: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type MissionSummary = z.infer<typeof MissionSummarySchema>;

/** What a Crew Member sees (DESIGN.md OQ-3): the mission and their own assignment, nothing else. */
export const CrewMissionSchema = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string(),
  startDate: IsoDate,
  endDate: IsoDate,
  status: MissionStatusSchema,
  assignment: z.object({ id: Uuid, acknowledgedAt: z.iso.datetime().nullable() }),
});
export type CrewMission = z.infer<typeof CrewMissionSchema>;

export const MissionViewSchema = z.union([MissionSchema, CrewMissionSchema]);
export type MissionView = z.infer<typeof MissionViewSchema>;

const MissionName = z.string().trim().min(1).max(MISSION_NAME_MAX_LENGTH);
const MissionDescription = z.string().trim().max(MISSION_DESCRIPTION_MAX_LENGTH);

export const CreateMissionRequestSchema = z
  .object({
    name: MissionName,
    description: MissionDescription.default(''),
    startDate: IsoDate,
    endDate: IsoDate,
  })
  .refine((v) => v.startDate <= v.endDate, {
    message: 'The end date must not be before the start date',
    path: ['endDate'],
  });
export type CreateMissionRequest = z.infer<typeof CreateMissionRequestSchema>;

export const UpdateMissionRequestSchema = z
  .object({
    name: MissionName.optional(),
    description: MissionDescription.optional(),
    startDate: IsoDate.optional(),
    endDate: IsoDate.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide something to change',
  })
  .refine((v) => v.startDate === undefined || v.endDate === undefined || v.startDate <= v.endDate, {
    message: 'The end date must not be before the start date',
    path: ['endDate'],
  });
export type UpdateMissionRequest = z.infer<typeof UpdateMissionRequestSchema>;

export const RequirementInputSchema = z.object({
  skillId: Uuid,
  minLevel: SkillLevelSchema,
  count: z.number().int().min(1).max(1000),
});

export const SetRequirementsRequestSchema = z
  .object({ requirements: z.array(RequirementInputSchema).max(MAX_REQUIREMENTS) })
  .refine((v) => new Set(v.requirements.map((r) => r.skillId)).size === v.requirements.length, {
    message: 'Each skill can appear in only one requirement',
    path: ['requirements'],
  });
export type SetRequirementsRequest = z.infer<typeof SetRequirementsRequestSchema>;

export const SetCrewRequestSchema = z
  .object({ crewMemberIds: z.array(Uuid).max(MAX_CREW) })
  .refine((v) => new Set(v.crewMemberIds).size === v.crewMemberIds.length, {
    message: 'A crew member can be listed only once',
    path: ['crewMemberIds'],
  });
export type SetCrewRequest = z.infer<typeof SetCrewRequestSchema>;

export const TransitionRequestSchema = z.object({
  action: MissionActionSchema,
  comment: z.string().trim().max(COMMENT_MAX_LENGTH).optional(),
});
export type TransitionRequest = z.infer<typeof TransitionRequestSchema>;

const StatusFilter = z
  .union([MissionStatusSchema, z.array(MissionStatusSchema).max(7)])
  .optional()
  .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]));

/** `from`/`to` select missions that overlap that window (inclusive days). */
export const ListMissionsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(25),
    status: StatusFilter,
    leadId: Uuid.optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
  })
  .refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, {
    message: 'from must not be after to',
    path: ['to'],
  });
export type ListMissionsQuery = z.infer<typeof ListMissionsQuerySchema>;
