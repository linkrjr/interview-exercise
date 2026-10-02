import type {
  Actor,
  AddUnavailabilityRequest,
  CrewProfile,
  CrewSkill,
  ListCrewQuery,
  Page,
  Unavailability,
} from '@mc/contracts';
import { AppError, ErrorCodes } from '@mc/contracts';
import { newId, schema, type Db, type Tx } from '@mc/db';
import { and, asc, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { AuditWriter } from '../audit.js';
import type { Clock } from '../clock.js';
import { todayIn } from '../dates.js';
import { notFound } from '../errors.js';
import { decodeCursor, toPage } from '../pagination.js';
import type { Policy } from '../policy/index.js';
import { getOrgSettings, userOrg } from './org-settings-service.js';
import { actorId } from './skill-service.js';

export interface CrewServiceDeps {
  db: Db;
  audit: AuditWriter;
  clock: Clock;
  policy: Policy;
}

export interface BlockingMission {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: string;
}

/** `daterange` for an inclusive pair of dates. */
const inclusiveRange = (from: string, to: string): SQL =>
  sql`daterange(${from}::date, ${to}::date, '[]')`;

/**
 * The missions that block an unavailability range (DESIGN.md OQ-1): those the person holds in
 * Pending approval, Approved or Active, i.e. their live holds, overlapping the range. This is the
 * one place that decides it; changing OQ-1 means changing this function.
 */
export async function findBlockingMissions(
  tx: Tx,
  crewMemberId: string,
  from: string,
  to: string,
): Promise<BlockingMission[]> {
  const rows = await tx
    .select({
      id: schema.missions.id,
      name: schema.missions.name,
      startDate: schema.missions.startDate,
      endDate: schema.missions.endDate,
      status: schema.missions.status,
    })
    .from(schema.holds)
    .innerJoin(schema.missions, eq(schema.missions.id, schema.holds.missionId))
    .where(
      and(
        eq(schema.holds.crewMemberId, crewMemberId),
        isNull(schema.holds.releasedAt),
        sql`${schema.holds.period} && ${inclusiveRange(from, to)}`,
      ),
    )
    .orderBy(asc(schema.missions.startDate), asc(schema.missions.id));
  return rows;
}

const fromColumn = sql<string>`lower(${schema.unavailability.period})::text`;
const toColumn = sql<string>`(upper(${schema.unavailability.period}) - 1)::text`;

export class CrewService {
  constructor(private readonly deps: CrewServiceDeps) {}

  /**
   * Active Crew Members, for Directors and Leads (a Crew Member gets only themself). Filters:
   * `skill` (each `<skillId>:<minLevel>` must hold) and `available` (no unavailability and no live
   * hold overlapping `<from>:<to>`).
   */
  async list(actor: Actor, query: ListCrewQuery): Promise<Page<CrewProfile>> {
    const { db, policy } = this.deps;
    policy.authorize(actor, 'crew.list');
    const orgId = userOrg(actor);
    const viewerId = actor.kind === 'user' ? actor.userId : '';
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;

    const conditions: (SQL | undefined)[] = [
      eq(schema.users.role, 'crew'),
      eq(schema.users.status, 'active'),
      actor.kind === 'user' && actor.role === 'crew'
        ? eq(schema.users.id, actor.userId)
        : undefined,
      after ? gt(schema.users.id, after) : undefined,
    ];
    for (const filter of query.skill) {
      const [skillId, level] = filter.split(':') as [string, string];
      conditions.push(sql`exists (
        select 1 from ${schema.crewSkills}
         where ${schema.crewSkills.crewMemberId} = ${schema.users.id}
           and ${schema.crewSkills.skillId} = ${skillId}
           and ${schema.crewSkills.level} >= ${Number(level)})`);
    }
    if (query.available) {
      const [from, to] = query.available.split(':') as [string, string];
      const window = inclusiveRange(from, to);
      conditions.push(sql`not exists (
        select 1 from ${schema.unavailability}
         where ${schema.unavailability.crewMemberId} = ${schema.users.id}
           and ${schema.unavailability.period} && ${window})`);
      conditions.push(sql`not exists (
        select 1 from ${schema.holds}
         where ${schema.holds.crewMemberId} = ${schema.users.id}
           and ${schema.holds.releasedAt} is null
           and ${schema.holds.period} && ${window})`);
    }

    return db.withTenant(orgId, async (tx) => {
      const users = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(...conditions))
        .orderBy(asc(schema.users.id))
        .limit(query.limit + 1);
      const page = toPage(users, query.limit, (u) => u.id);
      const profiles = await loadProfiles(tx, page.items, viewerId);
      return {
        items: page.items.flatMap((id) => profiles.get(id) ?? []),
        nextCursor: page.nextCursor,
      };
    });
  }

  async get(actor: Actor, crewMemberId: string): Promise<CrewProfile> {
    const { db, policy } = this.deps;
    // A Crew Member asking for anyone else gets 404, so profiles are not probed by id.
    policy.authorize(actor, 'crew.read', { userId: crewMemberId }, { concealAs404: 'Crew member' });
    return db.withTenant(userOrg(actor), async (tx) => {
      const viewerId = actor.kind === 'user' ? actor.userId : '';
      const [row] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(
          and(
            eq(schema.users.id, crewMemberId),
            eq(schema.users.role, 'crew'),
            eq(schema.users.status, 'active'),
          ),
        );
      const profile = row ? (await loadProfiles(tx, [row.id], viewerId)).get(row.id) : undefined;
      if (!profile) throw notFound('Crew member');
      return profile;
    });
  }

  /** Sets the signed-in Crew Member's own level for a skill (self-declared; OQ-5 allows it while held). */
  async setSkill(actor: Actor, skillId: string, level: number): Promise<CrewSkill> {
    const { db, audit, policy } = this.deps;
    policy.authorize(actor, 'crew.skill.edit');
    const orgId = userOrg(actor);
    const crewId = (actor as { userId: string }).userId;
    return db.withTenant(orgId, async (tx) => {
      const [skill] = await tx.select().from(schema.skills).where(eq(schema.skills.id, skillId));
      if (!skill) throw notFound('Skill');
      await requireProfile(tx, crewId);

      const [existing] = await tx
        .select({ level: schema.crewSkills.level })
        .from(schema.crewSkills)
        .where(
          and(eq(schema.crewSkills.crewMemberId, crewId), eq(schema.crewSkills.skillId, skillId)),
        )
        .for('update');
      if (existing?.level === level) return { skillId, name: skill.name, level };

      await tx
        .insert(schema.crewSkills)
        .values({ orgId, crewMemberId: crewId, skillId, level })
        .onConflictDoUpdate({
          target: [schema.crewSkills.crewMemberId, schema.crewSkills.skillId],
          set: { level },
        });
      await audit.record(tx, {
        action: 'crew.skill_set',
        entityType: 'crew_profile',
        entityId: crewId,
        before: existing ? { skillId, level: existing.level } : null,
        after: { skillId, level },
        actorId: actorId(actor),
      });
      return { skillId, name: skill.name, level };
    });
  }

  async removeSkill(actor: Actor, skillId: string): Promise<void> {
    const { db, audit, policy } = this.deps;
    policy.authorize(actor, 'crew.skill.edit');
    const crewId = (actor as { userId: string }).userId;
    await db.withTenant(userOrg(actor), async (tx) => {
      const removed = await tx
        .delete(schema.crewSkills)
        .where(
          and(eq(schema.crewSkills.crewMemberId, crewId), eq(schema.crewSkills.skillId, skillId)),
        )
        .returning({ level: schema.crewSkills.level });
      if (removed.length === 0) throw notFound('Skill level');
      await audit.record(tx, {
        action: 'crew.skill_removed',
        entityType: 'crew_profile',
        entityId: crewId,
        before: { skillId, level: removed[0]!.level },
        actorId: actorId(actor),
      });
    });
  }

  /**
   * Adds an unavailability range to the signed-in Crew Member. Rejected when it ends in the past
   * (org time zone), overlaps one of their own ranges, or overlaps a mission they are held on (OQ-1).
   * The profile row is locked first, so this serialises with a mission submission taking holds (§8).
   */
  async addUnavailability(actor: Actor, input: AddUnavailabilityRequest): Promise<Unavailability> {
    const { db, audit, clock, policy } = this.deps;
    policy.authorize(actor, 'crew.unavailability.edit');
    const orgId = userOrg(actor);
    const crewId = (actor as { userId: string }).userId;

    return db.withTenant(orgId, async (tx) => {
      await requireProfile(tx, crewId, true);

      const { timeZone } = await getOrgSettings(tx);
      const today = todayIn(clock.now(), timeZone);
      if (input.to < today) {
        throw new AppError(
          ErrorCodes.UNAVAILABILITY_IN_PAST,
          400,
          'The unavailability range ends in the past',
          {
            errors: [
              {
                field: 'to',
                code: ErrorCodes.UNAVAILABILITY_IN_PAST,
                message: `Must be ${today} or later`,
              },
            ],
          },
        );
      }

      const overlapping = await tx
        .select({ id: schema.unavailability.id, from: fromColumn, to: toColumn })
        .from(schema.unavailability)
        .where(
          and(
            eq(schema.unavailability.crewMemberId, crewId),
            sql`${schema.unavailability.period} && ${inclusiveRange(input.from, input.to)}`,
          ),
        )
        .orderBy(fromColumn);
      if (overlapping.length > 0) {
        throw new AppError(
          ErrorCodes.UNAVAILABILITY_OVERLAPS_EXISTING,
          409,
          'The range overlaps an unavailability range you already have',
          { unavailability: overlapping },
        );
      }

      const missions = await findBlockingMissions(tx, crewId, input.from, input.to);
      if (missions.length > 0) {
        throw new AppError(
          ErrorCodes.UNAVAILABILITY_CONFLICTS_WITH_MISSIONS,
          409,
          'You are committed to missions in that period; speak to the Mission Lead',
          { missions },
        );
      }

      const id = newId();
      await tx.insert(schema.unavailability).values({
        id,
        orgId,
        crewMemberId: crewId,
        period: sql`${inclusiveRange(input.from, input.to)}` as unknown as string,
        note: input.note || null,
        createdAt: clock.now(),
      });
      // The note is private to the crew member, so it stays out of the audit log Directors read.
      await audit.record(tx, {
        action: 'crew.unavailability_added',
        entityType: 'unavailability',
        entityId: id,
        after: { crewMemberId: crewId, from: input.from, to: input.to },
        actorId: actorId(actor),
      });
      return { id, from: input.from, to: input.to, note: input.note || null };
    });
  }

  async removeUnavailability(actor: Actor, id: string): Promise<void> {
    const { db, audit, policy } = this.deps;
    policy.authorize(actor, 'crew.unavailability.edit');
    const crewId = (actor as { userId: string }).userId;
    await db.withTenant(userOrg(actor), async (tx) => {
      const [row] = await tx
        .select({ from: fromColumn, to: toColumn })
        .from(schema.unavailability)
        .where(
          and(eq(schema.unavailability.id, id), eq(schema.unavailability.crewMemberId, crewId)),
        );
      if (!row) throw notFound('Unavailability range');
      const removed = await tx
        .delete(schema.unavailability)
        .where(
          and(eq(schema.unavailability.id, id), eq(schema.unavailability.crewMemberId, crewId)),
        )
        .returning({ id: schema.unavailability.id });
      if (removed.length === 0) throw notFound('Unavailability range'); // removed concurrently
      await audit.record(tx, {
        action: 'crew.unavailability_removed',
        entityType: 'unavailability',
        entityId: id,
        before: { crewMemberId: crewId, from: row.from, to: row.to },
        actorId: actorId(actor),
      });
    });
  }
}

async function requireProfile(tx: Tx, crewId: string, lock = false): Promise<void> {
  const query = tx
    .select({ id: schema.crewProfiles.userId })
    .from(schema.crewProfiles)
    .where(eq(schema.crewProfiles.userId, crewId));
  const [profile] = await (lock ? query.for('update') : query);
  if (!profile) throw notFound('Crew profile');
}

/** Profiles for the given users, in one query per table. Notes are shown only to their owner. */
async function loadProfiles(
  tx: Tx,
  ids: string[],
  viewerId: string,
): Promise<Map<string, CrewProfile>> {
  const profiles = new Map<string, CrewProfile>();
  if (ids.length === 0) return profiles;

  const users = await tx
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(inArray(schema.users.id, ids));
  for (const u of users) {
    profiles.set(u.id, {
      id: u.id,
      name: u.name,
      email: u.email,
      skills: [],
      unavailability: [],
      load: 0,
    });
  }

  const skills = await tx
    .select({
      crewMemberId: schema.crewSkills.crewMemberId,
      skillId: schema.crewSkills.skillId,
      name: schema.skills.name,
      level: schema.crewSkills.level,
    })
    .from(schema.crewSkills)
    .innerJoin(schema.skills, eq(schema.skills.id, schema.crewSkills.skillId))
    .where(inArray(schema.crewSkills.crewMemberId, ids))
    .orderBy(asc(schema.skills.name));
  for (const s of skills) {
    profiles.get(s.crewMemberId)?.skills.push({ skillId: s.skillId, name: s.name, level: s.level });
  }

  const ranges = await tx
    .select({
      id: schema.unavailability.id,
      crewMemberId: schema.unavailability.crewMemberId,
      from: fromColumn,
      to: toColumn,
      note: schema.unavailability.note,
    })
    .from(schema.unavailability)
    .where(inArray(schema.unavailability.crewMemberId, ids))
    .orderBy(fromColumn);
  for (const r of ranges) {
    const own = r.crewMemberId === viewerId;
    profiles.get(r.crewMemberId)?.unavailability.push({
      id: r.id,
      from: r.from,
      to: r.to,
      ...(own ? { note: r.note } : {}),
    });
  }

  const loads = await tx
    .select({ crewMemberId: schema.holds.crewMemberId, load: sql<number>`count(*)::int` })
    .from(schema.holds)
    .where(and(inArray(schema.holds.crewMemberId, ids), isNull(schema.holds.releasedAt)))
    .groupBy(schema.holds.crewMemberId);
  for (const l of loads) {
    const profile = profiles.get(l.crewMemberId);
    if (profile) profile.load = l.load;
  }
  return profiles;
}
