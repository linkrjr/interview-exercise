import {
  AppError,
  ErrorCodes,
  MATCH_PROPOSAL_TTL_MINUTES,
  type Actor,
  type Mission,
  type MatchProposal,
} from '@mc/contracts';
import { newId, schema, type Db, type Tx } from '@mc/db';
import {
  match,
  type MatchCandidate,
  type MatchRequirement,
  type MatchResult,
  type Solver,
} from '@mc/matcher';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import { sha256Hex } from '../crypto/secrets.js';
import { forbidden, notFound } from '../errors.js';
import { memberIssues, loadUpcomingLoad } from '../missions/eligibility.js';
import { checkVersion, lockMission, type MissionService } from '../missions/mission-service.js';
import type { Policy, UserActor } from '../policy/index.js';
import { getOrgSettings } from '../services/org-settings-service.js';

/**
 * The hash of a team (DESIGN.md §9.5): SHA-256 over the members' email addresses, lower-cased,
 * sorted and joined with newlines, so it does not depend on order or case.
 */
export function teamHashOf(emails: string[]): string {
  return sha256Hex(
    emails
      .map((e) => e.toLowerCase())
      .sort()
      .join('\n'),
  );
}

/** What is kept for a proposal until it is applied or expires. */
interface StoredProposal {
  missionVersion: number;
  memberIds: string[];
  result: MatchResult;
}

export interface MatchServiceDeps {
  db: Db;
  clock: Clock;
  policy: Policy;
  missions: MissionService;
  solver: Solver;
  /** Per-pass solver time limit; the engine's default (2 s) when omitted. */
  timeLimitSeconds?: number;
}

function userActor(actor: Actor): UserActor {
  if (actor.kind !== 'user') throw forbidden();
  return actor;
}

/**
 * The auto-matcher as a service: loads the facts for a Crewing mission, asks the pure engine for a
 * team, stores the proposal for 30 minutes, and applies it through the normal crew replacement.
 * Advisory: proposing changes nothing, and submit re-validates whatever is applied.
 */
export class MatchService {
  constructor(private readonly deps: MatchServiceDeps) {}

  /**
   * Proposes a team for a Crewing mission. Three steps, so that no transaction is open while the
   * solver works: (1) read the mission and the facts in a short transaction, (2) solve with no
   * transaction and no connection held, (3) store the proposal in a second transaction, which first
   * checks that the mission is still the version the proposal was computed for.
   */
  async propose(
    actor: Actor,
    missionId: string,
    input: { exclude: string[] },
  ): Promise<MatchProposal> {
    const { db, clock, policy, solver } = this.deps;
    // Only the owning Lead; a role that can never match learns nothing about the mission.
    policy.requireRole(actor, 'mission.manage');
    const caller = userActor(actor);

    const facts = await db.withTenant(caller.orgId, async (tx) => {
      const [mission] = await tx
        .select()
        .from(schema.missions)
        .where(eq(schema.missions.id, missionId));
      if (!mission) throw notFound('Mission');
      policy.authorize(actor, 'mission.manage', { leadId: mission.leadId });
      if (mission.status !== 'crewing') {
        throw new AppError(
          ErrorCodes.MISSION_NOT_EDITABLE,
          409,
          `A mission that is ${mission.status} cannot be matched`,
          {
            missionStatus: mission.status,
          },
        );
      }

      const settings = await getOrgSettings(tx);
      const requirements = await loadRequirements(tx, mission.id);
      const candidates = await loadCandidates(tx, mission, settings.maxUpcomingMissions);

      const known = new Set(candidates.map((c) => c.id));
      const unknown = input.exclude.filter((id) => !known.has(id));
      if (unknown.length) {
        throw new AppError(
          ErrorCodes.CREW_MEMBER_NOT_ASSIGNABLE,
          400,
          'Only active Crew Members of your organisation can be excluded',
          {
            crewMemberIds: unknown,
          },
        );
      }
      return {
        orgId: mission.orgId,
        missionId: mission.id,
        version: mission.version,
        requirements,
        candidates,
        cap: settings.maxUpcomingMissions,
      };
    });

    // No transaction is open here: the solver can take seconds in the worst case.
    const result = match(
      {
        missionId: facts.missionId,
        requirements: facts.requirements,
        candidates: facts.candidates,
        exclude: input.exclude,
        cap: facts.cap,
      },
      {
        solver,
        ...(this.deps.timeLimitSeconds ? { timeLimitSeconds: this.deps.timeLimitSeconds } : {}),
      },
    );
    const teamHash = teamHashOf(result.team.map((m) => m.email));
    const now = clock.now();
    const expiresAt = new Date(now.getTime() + MATCH_PROPOSAL_TTL_MINUTES * 60_000);
    const proposalId = newId();
    const stored: StoredProposal = {
      missionVersion: facts.version,
      memberIds: result.team.map((m) => m.crewMemberId),
      result,
    };

    await db.withTenant(caller.orgId, async (tx) => {
      const [mission] = await tx
        .select()
        .from(schema.missions)
        .where(eq(schema.missions.id, facts.missionId))
        .for('share');
      if (!mission || mission.status !== 'crewing' || mission.version !== facts.version) {
        throw new AppError(
          ErrorCodes.MATCH_PROPOSAL_STALE,
          409,
          'The mission changed while the proposal was being made; run the matcher again',
          {
            proposalVersion: facts.version,
            currentVersion: mission?.version ?? null,
          },
        );
      }
      // Tidy up. Expired proposals of any mission of the organisation are of no use, and neither are
      // earlier proposals of this mission made for an older version: a version never comes back.
      await tx.delete(schema.matchProposals).where(lte(schema.matchProposals.expiresAt, now));
      await tx
        .delete(schema.matchProposals)
        .where(
          and(
            eq(schema.matchProposals.missionId, facts.missionId),
            sql`(${schema.matchProposals.result} ->> 'missionVersion')::int < ${facts.version}`,
          ),
        );
      await tx.insert(schema.matchProposals).values({
        id: proposalId,
        orgId: facts.orgId,
        missionId: facts.missionId,
        teamHash,
        result: stored,
        expiresAt,
        createdAt: now,
      });
    });

    return {
      proposalId,
      ...result,
      teamHash,
      missionVersion: facts.version,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Replaces the tentative crew with a proposal, in one transaction: the mission is locked, and the
   * checks and the replacement cannot be separated by an expiry, an edit or a change of email. It
   * must be the owner's own request with the mission's current version (412 otherwise), the
   * proposal must exist (404), be unexpired (409), have been computed for this version of the
   * mission (409, stale), and the team hash the Lead was shown must match both the stored one and
   * the one recomputed from the members' current emails (409). Submission re-validates the crew
   * regardless.
   */
  async apply(
    actor: Actor,
    missionId: string,
    proposalId: string,
    input: { teamHash: string; version: number },
  ): Promise<Mission> {
    const { db, clock, policy, missions } = this.deps;
    policy.requireRole(actor, 'mission.manage');
    const caller = userActor(actor);

    return db.withTenant(caller.orgId, async (tx) => {
      const mission = await lockMission(tx, missionId);
      policy.authorize(actor, 'mission.manage', { leadId: mission.leadId });
      checkVersion(mission, input.version);

      const [row] = await tx
        .select()
        .from(schema.matchProposals)
        .where(
          and(
            eq(schema.matchProposals.id, proposalId),
            eq(schema.matchProposals.missionId, mission.id),
          ),
        );
      if (!row) throw notFound('Match proposal');
      if (row.expiresAt <= clock.now()) {
        throw new AppError(
          ErrorCodes.MATCH_PROPOSAL_EXPIRED,
          409,
          'The proposal has expired; run the matcher again',
        );
      }
      const stored = row.result as StoredProposal;
      if (stored.missionVersion !== mission.version) {
        throw new AppError(
          ErrorCodes.MATCH_PROPOSAL_STALE,
          409,
          'The mission changed after this proposal was made; run the matcher again',
          {
            proposalVersion: stored.missionVersion,
            currentVersion: mission.version,
          },
        );
      }

      const mismatch = () =>
        new AppError(
          ErrorCodes.MATCH_TEAM_HASH_MISMATCH,
          409,
          'The team no longer matches the proposal you were shown; run the matcher again',
        );
      if (input.teamHash !== row.teamHash) throw mismatch();
      const members = stored.memberIds.length
        ? await tx
            .select({ id: schema.users.id, email: schema.users.email })
            .from(schema.users)
            .where(inArray(schema.users.id, stored.memberIds))
        : [];
      if (
        members.length !== stored.memberIds.length ||
        teamHashOf(members.map((m) => m.email)) !== row.teamHash
      )
        throw mismatch();

      return missions.replaceCrew(actor, missionId, stored.memberIds, {
        version: input.version,
        matchProposalId: proposalId,
        within: tx,
      });
    });
  }
}

async function loadRequirements(tx: Tx, missionId: string): Promise<MatchRequirement[]> {
  const rows = await tx
    .select({
      skillId: schema.requirements.skillId,
      skillName: schema.skills.name,
      minLevel: schema.requirements.minLevel,
      count: schema.requirements.count,
    })
    .from(schema.requirements)
    .innerJoin(schema.skills, eq(schema.skills.id, schema.requirements.skillId))
    .where(eq(schema.requirements.missionId, missionId))
    .orderBy(asc(schema.requirements.skillId));
  return rows;
}

/** Every active Crew Member of the organisation, with their skills and the facts the rules need. */
async function loadCandidates(
  tx: Tx,
  mission: { id: string; startDate: string; endDate: string },
  cap: number,
): Promise<MatchCandidate[]> {
  const people = await tx
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(and(sql`${schema.users.role} = 'crew'`, sql`${schema.users.status} = 'active'`))
    .orderBy(asc(schema.users.id));
  if (people.length === 0) return [];
  const ids = people.map((p) => p.id);

  const skills = await tx
    .select()
    .from(schema.crewSkills)
    .where(inArray(schema.crewSkills.crewMemberId, ids));
  const levels = new Map<string, Record<string, number>>(ids.map((id) => [id, {}]));
  for (const s of skills) levels.get(s.crewMemberId)![s.skillId] = s.level;

  const issues = await memberIssues(tx, ids, mission, cap, { exceptMissionId: mission.id });
  const load = await loadUpcomingLoad(tx, ids, mission.id);
  return people.map((p) => ({
    id: p.id,
    name: p.name,
    email: p.email,
    load: load.get(p.id) ?? 0,
    skills: levels.get(p.id) ?? {},
    unavailable: issues.get(p.id)?.includes('UNAVAILABLE') ?? false,
    committed: issues.get(p.id)?.includes('DOUBLE_BOOKED') ?? false,
  }));
}
