import {
  AppError,
  ErrorCodes,
  type Actor,
  type CreateMissionRequest,
  type ListMissionsQuery,
  type MissionAction,
  type MissionSummary,
  type CrewMission,
  type Mission,
  type MissionView,
  type Page,
  type SetRequirementsRequest,
  type TransitionRequest,
  type UpdateMissionRequest,
} from '@mc/contracts';
import { newId, schema, type Db, type Tx } from '@mc/db';
import { and, asc, desc, eq, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import type { AuditWriter } from '../audit.js';
import type { Clock } from '../clock.js';
import { todayIn } from '../dates.js';
import { forbidden, notFound } from '../errors.js';
import { decodeCursor, toPage } from '../pagination.js';
import type { Policy, UserActor } from '../policy/index.js';
import { getOrgSettings } from '../services/org-settings-service.js';
import { memberIssues, requirementCoverage, type MemberIssue } from './eligibility.js';
import { releaseHolds, takeHolds } from './holds.js';
import {
  allowedActionsFor,
  crewVisibleClause,
  loadStaffMission,
  toCrewMission,
  toSummary,
  visibleAssignment,
} from './mission-view.js';
import type { NotificationService } from './notification-service.js';
import { EDITABLE_STATUSES, transitionFor, type TransitionName } from './state-machine.js';
import { applyTransition, type MissionRow } from './transitions.js';

export interface MissionServiceDeps {
  db: Db;
  audit: AuditWriter;
  clock: Clock;
  policy: Policy;
  notifications: NotificationService;
}

export interface SystemTransitionResult {
  expired: number;
  activated: number;
  completed: number;
}

const isUser = (actor: Actor): actor is UserActor => actor.kind === 'user';

function userActor(actor: Actor): UserActor {
  if (!isUser(actor)) throw forbidden();
  return actor;
}

const validation = (field: string, code: string, message: string) =>
  new AppError(ErrorCodes.VALIDATION_FAILED, 400, 'The request is invalid', {
    errors: [{ field, code, message }],
  });

/** The one failure kind submit reports, in this order of precedence, and the status of each. */
const ISSUE_CODES: Array<[MemberIssue, string]> = [
  ['NOT_ACTIVE', ErrorCodes.CREW_NOT_ACTIVE],
  ['UNAVAILABLE', ErrorCodes.CREW_UNAVAILABLE],
  ['DOUBLE_BOOKED', ErrorCodes.CREW_DOUBLE_BOOKED],
  ['AT_CAPACITY', ErrorCodes.WORKLOAD_CAP_EXCEEDED],
];

const ISSUE_DETAIL: Record<string, string> = {
  [ErrorCodes.CREW_NOT_ACTIVE]: 'Some assigned people are no longer active Crew Members',
  [ErrorCodes.CREW_UNAVAILABLE]:
    'Some assigned people have declared themselves unavailable in these dates',
  [ErrorCodes.CREW_DOUBLE_BOOKED]:
    'Some assigned people are already committed to another mission in these dates',
  [ErrorCodes.WORKLOAD_CAP_EXCEEDED]:
    "Some assigned people are at the organisation's limit of upcoming missions",
};

/** A concurrent submission can win between our check and our insert; the exclusion constraint catches it. */
function mapDoubleBooking(error: unknown): never {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    const e = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (e.code === '23P01' && e.constraint === 'holds_no_overlap') {
      throw new AppError(
        ErrorCodes.CREW_DOUBLE_BOOKED,
        409,
        ISSUE_DETAIL[ErrorCodes.CREW_DOUBLE_BOOKED]!,
      );
    }
    current = e.cause;
  }
  throw error;
}

export class MissionService {
  constructor(private readonly deps: MissionServiceDeps) {}

  // ---------------------------------------------------------------- reads

  async list(actor: Actor, query: ListMissionsQuery): Promise<Page<MissionSummary | CrewMission>> {
    const { db, policy } = this.deps;
    policy.authorize(actor, 'mission.list');
    const caller = userActor(actor);
    const before = query.cursor ? decodeCursor(query.cursor) : undefined;

    const filters: (SQL | undefined)[] = [
      query.status.length ? inArray(schema.missions.status, query.status) : undefined,
      query.leadId ? eq(schema.missions.leadId, query.leadId) : undefined,
      query.from ? gte(schema.missions.endDate, query.from) : undefined,
      query.to ? lte(schema.missions.startDate, query.to) : undefined,
      before ? lt(schema.missions.id, before) : undefined,
    ];

    return db.withTenant(caller.orgId, async (tx) => {
      if (caller.role === 'crew') {
        const rows = await tx
          .select({ mission: schema.missions, assignment: schema.assignments })
          .from(schema.missions)
          .innerJoin(
            schema.assignments,
            and(
              eq(schema.assignments.missionId, schema.missions.id),
              eq(schema.assignments.crewMemberId, caller.userId),
            ),
          )
          .where(and(crewVisibleClause, ...filters))
          .orderBy(desc(schema.missions.id))
          .limit(query.limit + 1);
        const page = toPage(
          rows.map((r) => ({ id: r.mission.id, ...r })),
          query.limit,
          (r) => toCrewMission(r.mission, r.assignment),
        );
        return page;
      }
      const rows = await tx
        .select({ mission: schema.missions, leadName: schema.users.name })
        .from(schema.missions)
        .innerJoin(schema.users, eq(schema.users.id, schema.missions.leadId))
        .where(and(...filters))
        .orderBy(desc(schema.missions.id))
        .limit(query.limit + 1);
      return toPage(
        rows.map((r) => ({ id: r.mission.id, ...r })),
        query.limit,
        (r) => toSummary(r.mission, r.leadName),
      );
    });
  }

  async get(actor: Actor, missionId: string): Promise<MissionView> {
    const { db, policy } = this.deps;
    policy.authorize(actor, 'mission.read');
    const caller = userActor(actor);
    return db.withTenant(caller.orgId, async (tx) => {
      const row = await findMission(tx, missionId);
      if (!row) throw notFound('Mission');
      return this.viewFor(tx, row, caller);
    });
  }

  // ------------------------------------------------------------ mutations

  async create(actor: Actor, input: CreateMissionRequest): Promise<Mission> {
    const { db, audit, clock, policy } = this.deps;
    policy.authorize(actor, 'mission.create');
    const lead = userActor(actor);
    return db.withTenant(lead.orgId, async (tx) => {
      const [row] = await tx
        .insert(schema.missions)
        .values({
          id: newId(),
          orgId: lead.orgId,
          leadId: lead.userId,
          name: input.name,
          description: input.description,
          startDate: input.startDate,
          endDate: input.endDate,
          createdAt: clock.now(),
        })
        .returning();
      await audit.record(tx, {
        action: 'mission.created',
        entityType: 'mission',
        entityId: row!.id,
        after: {
          name: row!.name,
          startDate: row!.startDate,
          endDate: row!.endDate,
          status: row!.status,
        },
        actorId: lead.userId,
      });
      return this.staffView(tx, row!, lead);
    });
  }

  /** Edits name, description and dates. Allowed in Draft and Crewing; nothing is removed or blocked by it (§7.1). */
  async update(
    actor: Actor,
    missionId: string,
    patch: UpdateMissionRequest,
    version: number,
  ): Promise<Mission> {
    const { audit } = this.deps;
    return this.mutate(actor, missionId, version, async (tx, mission, caller) => {
      const next = {
        name: patch.name ?? mission.name,
        description: patch.description ?? mission.description,
        startDate: patch.startDate ?? mission.startDate,
        endDate: patch.endDate ?? mission.endDate,
      };
      if (next.startDate > next.endDate) {
        throw validation(
          'endDate',
          'invalid_range',
          'The end date must not be before the start date',
        );
      }
      const before: Record<string, string> = {};
      const after: Record<string, string> = {};
      for (const key of ['name', 'description', 'startDate', 'endDate'] as const) {
        if (next[key] !== mission[key]) {
          before[key] = mission[key];
          after[key] = next[key];
        }
      }
      if (Object.keys(after).length === 0) return { row: mission, changed: false };
      const row = await bumpVersion(tx, mission.id, next);
      await audit.record(tx, {
        action: 'mission.updated',
        entityType: 'mission',
        entityId: mission.id,
        before,
        after,
        actorId: caller.userId,
      });
      return { row, changed: true };
    });
  }

  /** Replaces the whole requirement set (Draft and Crewing). A Crewing mission must keep at least one. */
  async setRequirements(
    actor: Actor,
    missionId: string,
    input: SetRequirementsRequest,
    version: number,
  ): Promise<Mission> {
    const { audit } = this.deps;
    return this.mutate(actor, missionId, version, async (tx, mission, caller) => {
      if (mission.status === 'crewing' && input.requirements.length === 0) {
        throw new AppError(
          ErrorCodes.MISSION_REQUIREMENTS_REQUIRED,
          409,
          'A mission that is being crewed needs at least one requirement',
        );
      }
      const skillIds = input.requirements.map((r) => r.skillId);
      const known = skillIds.length
        ? new Set(
            (
              await tx
                .select({ id: schema.skills.id })
                .from(schema.skills)
                .where(inArray(schema.skills.id, skillIds))
            ).map((s) => s.id),
          )
        : new Set<string>();
      const missing = input.requirements.findIndex((r) => !known.has(r.skillId));
      if (missing >= 0)
        throw validation(`requirements.${missing}.skillId`, 'NOT_FOUND', 'No such skill');

      const existing = await tx
        .select()
        .from(schema.requirements)
        .where(eq(schema.requirements.missionId, mission.id));
      const describe = (rs: Array<{ skillId: string; minLevel: number; count: number }>) =>
        rs
          .map((r) => ({ skillId: r.skillId, minLevel: r.minLevel, count: r.count }))
          .sort((a, b) => a.skillId.localeCompare(b.skillId));
      const before = describe(existing);
      const after = describe(input.requirements);
      if (JSON.stringify(before) === JSON.stringify(after)) return { row: mission, changed: false };

      await tx.delete(schema.requirements).where(eq(schema.requirements.missionId, mission.id));
      if (input.requirements.length) {
        await tx.insert(schema.requirements).values(
          input.requirements.map((r) => ({
            id: newId(),
            orgId: mission.orgId,
            missionId: mission.id,
            skillId: r.skillId,
            minLevel: r.minLevel,
            count: r.count,
          })),
        );
      }
      const row = await bumpVersion(tx, mission.id, {});
      await audit.record(tx, {
        action: 'mission.requirements_set',
        entityType: 'mission',
        entityId: mission.id,
        before,
        after,
        actorId: caller.userId,
      });
      return { row, changed: true };
    });
  }

  /**
   * Replaces the tentative crew (Crewing only). Used by the Lead directly and by the matcher's apply
   * step. It never checks eligibility: an ineligible crew is reported by `crewValidation` and only
   * submit is blocked (§7.1).
   */
  async replaceCrew(
    actor: Actor,
    missionId: string,
    crewMemberIds: string[],
    {
      version,
      matchProposalId,
      within,
    }: { version: number; matchProposalId?: string; within?: Tx },
  ): Promise<Mission> {
    const { audit } = this.deps;
    // With `within` the change runs in the caller's transaction (the matcher's apply does its own
    // checks and the replacement atomically); otherwise it opens its own.
    const run: typeof this.mutate = within
      ? (a, id, v, change, statuses) => this.mutateIn(within, a, id, v, change, statuses)
      : (a, id, v, change, statuses) => this.mutate(a, id, v, change, statuses);
    return run(
      actor,
      missionId,
      version,
      async (tx, mission, caller) => {
        const ids = [...new Set(crewMemberIds)];
        const assignable = ids.length
          ? new Set(
              (
                await tx
                  .select({ id: schema.users.id })
                  .from(schema.users)
                  .where(
                    and(
                      inArray(schema.users.id, ids),
                      sql`${schema.users.role} = 'crew'`,
                      sql`${schema.users.status} = 'active'`,
                    ),
                  )
              ).map((u) => u.id),
            )
          : new Set<string>();
        const rejected = ids.filter((id) => !assignable.has(id));
        if (rejected.length) {
          throw new AppError(
            ErrorCodes.CREW_MEMBER_NOT_ASSIGNABLE,
            400,
            'Only active Crew Members of your organisation can be assigned',
            { crewMemberIds: rejected },
          );
        }

        const current = await tx
          .select()
          .from(schema.assignments)
          .where(eq(schema.assignments.missionId, mission.id));
        const keep = new Set(current.map((a) => a.crewMemberId));
        const removed = current.filter((a) => !ids.includes(a.crewMemberId));
        const added = ids.filter((id) => !keep.has(id));
        if (removed.length === 0 && added.length === 0) return { row: mission, changed: false };

        if (removed.length) {
          await tx.delete(schema.assignments).where(
            inArray(
              schema.assignments.id,
              removed.map((a) => a.id),
            ),
          );
        }
        if (added.length) {
          await tx.insert(schema.assignments).values(
            added.map((crewMemberId) => ({
              id: newId(),
              orgId: mission.orgId,
              missionId: mission.id,
              crewMemberId,
              assignedBy: caller.userId,
            })),
          );
        }
        const row = await bumpVersion(tx, mission.id, {});
        await audit.record(tx, {
          action: 'mission.crew_set',
          entityType: 'mission',
          entityId: mission.id,
          before: { crewMemberIds: current.map((a) => a.crewMemberId).sort() },
          after: {
            crewMemberIds: [...ids].sort(),
            ...(matchProposalId ? { matchProposalId } : {}),
          },
          actorId: caller.userId,
        });
        return { row, changed: true };
      },
      ['crewing'],
    );
  }

  // ----------------------------------------------------------- lifecycle

  /** Runs one user action through the state machine (DESIGN.md §7.2). */
  async transition(
    actor: Actor,
    missionId: string,
    input: TransitionRequest,
    version: number,
  ): Promise<Mission> {
    const { db, audit, clock, policy, notifications } = this.deps;
    const def = transitionFor(input.action);
    const rule = def.by === 'director' ? 'mission.decide' : 'mission.manage';
    // A role that can never do this learns nothing about the mission: 403 before it is even loaded.
    policy.requireRole(actor, rule);
    const caller = userActor(actor);

    try {
      return await db.withTenant(caller.orgId, async (tx) => {
        const mission = await lockMission(tx, missionId);
        if (def.by === 'director') {
          // Directors never own missions (§5.2 invariant 8); asserted anyway.
          if (mission.leadId === caller.userId) throw forbidden();
        } else {
          policy.authorize(actor, rule, { leadId: mission.leadId });
        }
        checkVersion(mission, version);
        if (!def.from.includes(mission.status))
          throw invalidTransition(caller, mission, input.action);

        const now = clock.now();
        const settings = await getOrgSettings(tx);
        const today = todayIn(now, settings.timeZone);
        const payload = {
          missionId: mission.id,
          missionName: mission.name,
          startDate: mission.startDate,
          endDate: mission.endDate,
        };
        // A comment of only whitespace is no comment.
        const comment = input.comment?.trim() || undefined;
        let updated: MissionRow;

        switch (input.action) {
          case 'start_crewing': {
            if (mission.startDate < today) throw startInPast(mission.startDate, today);
            const [{ n }] = (await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(schema.requirements)
              .where(eq(schema.requirements.missionId, mission.id))) as [{ n: number }];
            if (n === 0) {
              throw new AppError(
                ErrorCodes.MISSION_REQUIREMENTS_REQUIRED,
                409,
                'Add at least one requirement before crewing',
              );
            }
            updated = await applyTransition(tx, mission, 'start_crewing');
            break;
          }
          case 'reopen': {
            // Back to Draft clears the tentative crew; their released holds stay as history.
            await tx.delete(schema.assignments).where(eq(schema.assignments.missionId, mission.id));
            updated = await applyTransition(tx, mission, 'reopen');
            break;
          }
          case 'submit': {
            if (mission.startDate < today) throw startInPast(mission.startDate, today);
            const assignments = await tx
              .select()
              .from(schema.assignments)
              .where(eq(schema.assignments.missionId, mission.id))
              .orderBy(asc(schema.assignments.crewMemberId));
            if (assignments.length === 0) {
              throw new AppError(
                ErrorCodes.MISSION_CREW_EMPTY,
                409,
                'Assign at least one crew member before submitting',
              );
            }
            const ids = assignments.map((a) => a.crewMemberId);
            // Serialise with any other submission or unavailability change touching these people (§8).
            await tx
              .select({ id: schema.crewProfiles.userId })
              .from(schema.crewProfiles)
              .where(inArray(schema.crewProfiles.userId, ids))
              .orderBy(asc(schema.crewProfiles.userId))
              .for('update');

            // Facts about the people come first (someone no longer active, unavailable, booked or at
            // the cap), then whether the crew covers the requirements.
            const issues = await memberIssues(tx, ids, mission, settings.maxUpcomingMissions, {
              exceptMissionId: mission.id,
            });
            if (issues.size) {
              const grouped = ISSUE_CODES.flatMap(([issue, code]) => {
                const crewMemberIds = ids.filter((id) => issues.get(id)?.includes(issue));
                return crewMemberIds.length ? [{ code, crewMemberIds }] : [];
              });
              const first = grouped[0]!;
              throw new AppError(first.code, 409, ISSUE_DETAIL[first.code]!, { issues: grouped });
            }
            const unmet = (await requirementCoverage(tx, mission.id, ids)).filter(
              (c) => c.met < c.required,
            );
            if (unmet.length) {
              throw new AppError(
                ErrorCodes.REQUIREMENTS_NOT_MET,
                409,
                'The crew does not satisfy every requirement',
                { unmetRequirements: unmet },
              );
            }
            await takeHolds(
              tx,
              mission.orgId,
              mission,
              assignments.map((a) => ({ id: a.id, crewMemberId: a.crewMemberId })),
              now,
            );
            updated = await applyTransition(tx, mission, 'submit');
            const directors = await tx
              .select({ id: schema.users.id })
              .from(schema.users)
              .where(
                and(sql`${schema.users.role} = 'director'`, sql`${schema.users.status} = 'active'`),
              );
            await notifications.notify(
              tx,
              directors.map((d) => d.id),
              'mission.submitted',
              payload,
            );
            break;
          }
          case 'withdraw': {
            await releaseHolds(tx, mission.id, 'withdrawn', now);
            updated = await applyTransition(tx, mission, 'withdraw');
            break;
          }
          case 'approve': {
            if (mission.startDate < today) throw startInPast(mission.startDate, today);
            await tx.insert(schema.approvalDecisions).values({
              id: newId(),
              orgId: mission.orgId,
              missionId: mission.id,
              directorId: caller.userId,
              decision: 'approved',
              comment: comment ?? null,
              decidedAt: now,
              createdAt: now,
            });
            updated = await applyTransition(tx, mission, 'approve');
            const crew = await tx
              .select({ id: schema.assignments.crewMemberId })
              .from(schema.assignments)
              .where(eq(schema.assignments.missionId, mission.id));
            await notifications.notify(tx, [mission.leadId], 'mission.approved', {
              ...payload,
              ...(comment ? { comment } : {}),
            });
            await notifications.notify(
              tx,
              crew.map((c) => c.id),
              'mission.assigned',
              payload,
            );
            break;
          }
          case 'reject': {
            if (!comment) {
              throw new AppError(
                ErrorCodes.REJECTION_REASON_REQUIRED,
                400,
                'A reason is required to reject a mission',
                {
                  errors: [
                    {
                      field: 'comment',
                      code: ErrorCodes.REJECTION_REASON_REQUIRED,
                      message: 'Give the reason for rejecting',
                    },
                  ],
                },
              );
            }
            await releaseHolds(tx, mission.id, 'rejected', now);
            await tx.insert(schema.approvalDecisions).values({
              id: newId(),
              orgId: mission.orgId,
              missionId: mission.id,
              directorId: caller.userId,
              decision: 'rejected',
              comment,
              decidedAt: now,
              createdAt: now,
            });
            updated = await applyTransition(tx, mission, 'reject');
            await notifications.notify(tx, [mission.leadId], 'mission.rejected', {
              ...payload,
              reason: comment,
            });
            break;
          }
          case 'cancel': {
            await releaseHolds(tx, mission.id, 'cancelled', now);
            updated = await applyTransition(tx, mission, 'cancel');
            if (mission.status === 'approved') {
              const crew = await tx
                .select({ id: schema.assignments.crewMemberId })
                .from(schema.assignments)
                .where(eq(schema.assignments.missionId, mission.id));
              await notifications.notify(
                tx,
                crew.map((c) => c.id),
                'mission.cancelled',
                payload,
              );
            }
            break;
          }
        }

        await audit.record(tx, {
          action: `mission.${input.action}`,
          entityType: 'mission',
          entityId: mission.id,
          before: { status: mission.status, version: mission.version },
          after: {
            status: updated.status,
            version: updated.version,
            ...(comment ? { comment } : {}),
          },
          actorId: caller.userId,
        });
        return this.staffView(tx, updated, caller);
      });
    } catch (error) {
      return mapDoubleBooking(error);
    }
  }

  /**
   * The date-driven transitions, for one organisation (`tx` is its tenant transaction, `today` its
   * date in its time zone): Pending approval missions whose start passed return to Crewing, Approved
   * ones that have started become Active, Active ones that have ended become Completed. Idempotent:
   * rerunning with the same `today` changes nothing. The scheduler (Spec 06) only calls this.
   */
  async runSystemTransitions(tx: Tx, today: string): Promise<SystemTransitionResult> {
    const { audit, clock, notifications } = this.deps;
    const now = clock.now();
    const result: SystemTransitionResult = { expired: 0, activated: 0, completed: 0 };

    const due = (status: MissionRow['status'], condition: SQL) =>
      tx
        .select()
        .from(schema.missions)
        .where(and(eq(schema.missions.status, status), condition))
        .orderBy(asc(schema.missions.id))
        .for('update');

    const record = (
      before: MissionRow,
      after: MissionRow,
      action: TransitionName,
      extra: object = {},
    ) =>
      audit.record(tx, {
        action: `mission.${action}`,
        entityType: 'mission',
        entityId: before.id,
        before: { status: before.status, version: before.version },
        after: { status: after.status, version: after.version, ...extra },
        actorId: null,
      });

    for (const mission of await due('pending_approval', lt(schema.missions.startDate, today))) {
      await releaseHolds(tx, mission.id, 'expired', now);
      const updated = await applyTransition(tx, mission, 'expire');
      await notifications.notify(tx, [mission.leadId], 'mission.expired', {
        missionId: mission.id,
        missionName: mission.name,
        startDate: mission.startDate,
        endDate: mission.endDate,
        reason: 'start date passed',
      });
      await record(mission, updated, 'expire', { reason: 'start date passed' });
      result.expired++;
    }
    for (const mission of await due('approved', lte(schema.missions.startDate, today))) {
      await record(mission, await applyTransition(tx, mission, 'activate'), 'activate');
      result.activated++;
    }
    for (const mission of await due('active', lt(schema.missions.endDate, today))) {
      await releaseHolds(tx, mission.id, 'completed', now);
      await record(mission, await applyTransition(tx, mission, 'complete'), 'complete');
      result.completed++;
    }
    return result;
  }

  // -------------------------------------------------------------- helpers

  /**
   * Loads and locks the mission for an edit by its owning Lead, checks the version and that the
   * status is one of `statuses` (default: Draft or Crewing, for details and requirements; the crew
   * passes Crewing only), runs `change`, and returns the refreshed view.
   */
  private async mutate(
    actor: Actor,
    missionId: string,
    version: number,
    change: (
      tx: Tx,
      mission: MissionRow,
      caller: UserActor,
    ) => Promise<{ row: MissionRow; changed: boolean }>,
    statuses: readonly MissionRow['status'][] = EDITABLE_STATUSES,
  ): Promise<Mission> {
    const { db, policy } = this.deps;
    policy.requireRole(actor, 'mission.manage');
    const caller = userActor(actor);
    return db.withTenant(caller.orgId, (tx) =>
      this.mutateIn(tx, actor, missionId, version, change, statuses),
    );
  }

  /** `mutate` inside a transaction the caller already holds, for the owning Lead's change. */
  private async mutateIn(
    tx: Tx,
    actor: Actor,
    missionId: string,
    version: number,
    change: (
      tx: Tx,
      mission: MissionRow,
      caller: UserActor,
    ) => Promise<{ row: MissionRow; changed: boolean }>,
    statuses: readonly MissionRow['status'][] = EDITABLE_STATUSES,
  ): Promise<Mission> {
    const { policy } = this.deps;
    policy.requireRole(actor, 'mission.manage');
    const caller = userActor(actor);
    const mission = await lockMission(tx, missionId);
    policy.authorize(actor, 'mission.manage', { leadId: mission.leadId });
    checkVersion(mission, version);
    if (!statuses.includes(mission.status)) {
      throw new AppError(
        ErrorCodes.MISSION_NOT_EDITABLE,
        409,
        `A mission that is ${mission.status} cannot be changed this way`,
        { missionStatus: mission.status },
      );
    }
    const { row } = await change(tx, mission, caller);
    return this.staffView(tx, row, caller);
  }

  private async staffView(tx: Tx, row: MissionRow, actor: UserActor): Promise<Mission> {
    const settings = await getOrgSettings(tx);
    return loadStaffMission(tx, row, actor, settings.maxUpcomingMissions);
  }

  private async viewFor(tx: Tx, row: MissionRow, actor: UserActor): Promise<MissionView> {
    if (actor.role !== 'crew') return this.staffView(tx, row, actor);
    const assignment = await visibleAssignment(tx, row.id, actor.userId);
    if (!assignment) throw notFound('Mission');
    return toCrewMission(row, assignment);
  }
}

async function findMission(tx: Tx, id: string): Promise<MissionRow | undefined> {
  const [row] = await tx.select().from(schema.missions).where(eq(schema.missions.id, id));
  return row;
}

export async function lockMission(tx: Tx, id: string): Promise<MissionRow> {
  const [row] = await tx
    .select()
    .from(schema.missions)
    .where(eq(schema.missions.id, id))
    .for('update');
  if (!row) throw notFound('Mission');
  return row;
}

/** Optimistic concurrency (DESIGN.md §13): a stale version is a 412 carrying the current one. */
export function checkVersion(mission: MissionRow, version: number): void {
  if (mission.version !== version) {
    throw new AppError(
      ErrorCodes.MISSION_VERSION_MISMATCH,
      412,
      'The mission was changed by someone else; reload it',
      {
        currentVersion: mission.version,
      },
    );
  }
}

/** Updates details (never the status) and bumps the version. */
async function bumpVersion(
  tx: Tx,
  id: string,
  fields: Partial<Pick<MissionRow, 'name' | 'description' | 'startDate' | 'endDate'>>,
): Promise<MissionRow> {
  const [row] = await tx
    .update(schema.missions)
    .set({ ...fields, version: sql`${schema.missions.version} + 1` })
    .where(eq(schema.missions.id, id))
    .returning();
  return row!;
}

function invalidTransition(actor: UserActor, mission: MissionRow, action: MissionAction): AppError {
  const allowedActions = allowedActionsFor(actor, mission);
  return new AppError(
    ErrorCodes.MISSION_INVALID_TRANSITION,
    409,
    `Cannot ${action} a mission that is ${mission.status}`,
    { missionStatus: mission.status, allowedActions },
  );
}

const startInPast = (startDate: string, today: string) =>
  new AppError(
    ErrorCodes.MISSION_START_IN_PAST,
    409,
    `The start date ${startDate} has passed (today is ${today})`,
  );
