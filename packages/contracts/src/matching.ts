import { z } from 'zod';
import { MAX_CREW } from './missions.js';

const Uuid = z.uuid();

export const MATCH_PROPOSAL_TTL_MINUTES = 30;

/**
 * Who must not be on the proposed team. There is no way to force anyone onto it (DESIGN.md §9.1),
 * so unknown keys such as `pin` are refused rather than silently ignored.
 */
export const MatchRequestSchema = z.strictObject({
  exclude: z
    .array(Uuid)
    .max(MAX_CREW)
    .default([])
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'A crew member can be listed only once',
    }),
});
export type MatchRequest = z.infer<typeof MatchRequestSchema>;

export const BlockReasonSchema = z.enum(['UNAVAILABLE', 'COMMITTED', 'AT_CAPACITY', 'EXCLUDED']);

export const MatchTeamMemberSchema = z.object({
  crewMemberId: Uuid,
  name: z.string().nullable(),
  email: z.string(),
  upcomingMissions: z.number().int().min(0),
  covers: z.array(
    z.object({
      skillId: Uuid,
      skill: z.string(),
      level: z.number().int(),
      required: z.number().int(),
    }),
  ),
});

export const MatchCoverageSchema = z.object({
  skillId: Uuid,
  skill: z.string(),
  minLevel: z.number().int(),
  required: z.number().int(),
  met: z.number().int(),
  /** Present only when the requirement is not met: counts by reason, never names (DESIGN.md §9.4). */
  gap: z
    .object({
      qualifiedTotal: z.number().int(),
      blocked: z.record(BlockReasonSchema, z.number().int()),
    })
    .optional(),
});

export const MatchAlternateSchema = z.object({
  crewMemberId: Uuid,
  name: z.string().nullable(),
  email: z.string(),
  upcomingMissions: z.number().int().min(0),
  level: z.number().int(),
});

/** The matcher's proposal (DESIGN.md §9.4). Advisory: nothing changes until it is applied. */
export const MatchProposalSchema = z.object({
  proposalId: Uuid,
  missionId: Uuid,
  method: z.enum(['exact', 'heuristic']),
  /** Every requirement is met. */
  complete: z.boolean(),
  team: z.array(MatchTeamMemberSchema),
  coverage: z.array(MatchCoverageSchema),
  alternates: z.array(
    z.object({ skillId: Uuid, skill: z.string(), candidates: z.array(MatchAlternateSchema) }),
  ),
  /** SHA-256 over the team's lower-cased, sorted email addresses; send it back to apply the proposal. */
  teamHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The mission version the proposal was computed for. */
  missionVersion: z.number().int().min(1),
  expiresAt: z.iso.datetime(),
});
export type MatchProposal = z.infer<typeof MatchProposalSchema>;

export const ApplyMatchRequestSchema = z.strictObject({
  teamHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'Expected the 64-character team hash from the proposal'),
});
export type ApplyMatchRequest = z.infer<typeof ApplyMatchRequestSchema>;
