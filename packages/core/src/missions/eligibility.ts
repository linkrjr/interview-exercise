import { schema, type Tx } from '@mc/db';
import { and, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';

export type MemberIssue = 'NOT_ACTIVE' | 'UNAVAILABLE' | 'DOUBLE_BOOKED' | 'AT_CAPACITY';

export interface DateRange {
  startDate: string;
  endDate: string;
}

const inclusiveRange = (r: DateRange): SQL =>
  sql`daterange(${r.startDate}::date, ${r.endDate}::date, '[]')`;

/**
 * Why each of these people cannot take a mission over `range` (DESIGN.md §9.2, §8), by person.
 * People with no issue are absent from the map. One function serves the crew validation of a
 * Crewing mission (which reports only "not eligible") and submit (which names the kind).
 *
 * `AT_CAPACITY` means the person already holds `cap` missions, so one more would exceed it.
 */
export async function memberIssues(
  tx: Tx,
  memberIds: string[],
  range: DateRange,
  cap: number,
  options: { exceptMissionId?: string } = {},
): Promise<Map<string, MemberIssue[]>> {
  const issues = new Map<string, MemberIssue[]>();
  if (memberIds.length === 0) return issues;
  const add = (id: string, issue: MemberIssue) =>
    issues.set(id, [...(issues.get(id) ?? []), issue]);

  const active = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        inArray(schema.users.id, memberIds),
        sql`${schema.users.role} = 'crew'`,
        sql`${schema.users.status} = 'active'`,
      ),
    );
  const activeIds = new Set(active.map((u) => u.id));
  for (const id of memberIds) if (!activeIds.has(id)) add(id, 'NOT_ACTIVE');

  const unavailable = await tx
    .selectDistinct({ id: schema.unavailability.crewMemberId })
    .from(schema.unavailability)
    .where(
      and(
        inArray(schema.unavailability.crewMemberId, memberIds),
        sql`${schema.unavailability.period} && ${inclusiveRange(range)}`,
      ),
    );
  for (const u of unavailable) add(u.id, 'UNAVAILABLE');

  const liveHolds = and(
    inArray(schema.holds.crewMemberId, memberIds),
    isNull(schema.holds.releasedAt),
    options.exceptMissionId ? ne(schema.holds.missionId, options.exceptMissionId) : undefined,
  );
  const booked = await tx
    .selectDistinct({ id: schema.holds.crewMemberId })
    .from(schema.holds)
    .where(and(liveHolds, sql`${schema.holds.period} && ${inclusiveRange(range)}`));
  for (const b of booked) add(b.id, 'DOUBLE_BOOKED');

  const load = await loadUpcomingLoad(tx, memberIds, options.exceptMissionId);
  for (const id of memberIds) if ((load.get(id) ?? 0) >= cap) add(id, 'AT_CAPACITY');

  return issues;
}

/**
 * Upcoming missions per person: their live holds (Pending approval, Approved, Active), the
 * workload the cap applies to (DESIGN.md §8). People with none are present with 0.
 */
export async function loadUpcomingLoad(
  tx: Tx,
  crewMemberIds: string[],
  exceptMissionId?: string,
): Promise<Map<string, number>> {
  const load = new Map<string, number>(crewMemberIds.map((id) => [id, 0]));
  if (crewMemberIds.length === 0) return load;
  const rows = await tx
    .select({ id: schema.holds.crewMemberId, n: sql<number>`count(*)::int` })
    .from(schema.holds)
    .where(
      and(
        inArray(schema.holds.crewMemberId, crewMemberIds),
        isNull(schema.holds.releasedAt),
        exceptMissionId ? ne(schema.holds.missionId, exceptMissionId) : undefined,
      ),
    )
    .groupBy(schema.holds.crewMemberId);
  for (const r of rows) load.set(r.id, r.n);
  return load;
}

export interface RequirementCoverage {
  skillId: string;
  minLevel: number;
  required: number;
  met: number;
}

/**
 * For each requirement of the mission, how many of these people satisfy it: active Crew Members
 * holding the skill at the minimum level or above. One person can satisfy several requirements.
 */
export async function requirementCoverage(
  tx: Tx,
  missionId: string,
  memberIds: string[],
): Promise<RequirementCoverage[]> {
  const requirements = await tx
    .select()
    .from(schema.requirements)
    .where(sql`${schema.requirements.missionId} = ${missionId}`)
    .orderBy(schema.requirements.skillId);
  if (requirements.length === 0) return [];

  const levels = new Map<string, Map<string, number>>();
  if (memberIds.length > 0) {
    const active = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        and(
          inArray(schema.users.id, memberIds),
          sql`${schema.users.role} = 'crew'`,
          sql`${schema.users.status} = 'active'`,
        ),
      );
    const activeIds = active.map((u) => u.id);
    if (activeIds.length > 0) {
      const skills = await tx
        .select()
        .from(schema.crewSkills)
        .where(inArray(schema.crewSkills.crewMemberId, activeIds));
      for (const id of activeIds) levels.set(id, new Map());
      for (const s of skills) levels.get(s.crewMemberId)?.set(s.skillId, s.level);
    }
  }

  return requirements.map((r) => ({
    skillId: r.skillId,
    minLevel: r.minLevel,
    required: r.count,
    met: [...levels.values()].filter((byskill) => (byskill.get(r.skillId) ?? 0) >= r.minLevel)
      .length,
  }));
}
