import { qualifies, type Context } from './context.js';
import { scoreOf } from './score.js';
import {
  BLOCK_REASONS,
  type Alternate,
  type BlockReason,
  type CoverageLine,
  type MatchResult,
  type TeamMember,
} from './types.js';

const MAX_ALTERNATES = 3;

/**
 * Turns a team (pool indexes) into the result of DESIGN.md §9.4: the team with what each person
 * covers, coverage per requirement with an explanation of any gap, and the next-best candidates.
 * Blocked people are only ever counted, by reason, never named.
 */
export function buildResult(
  ctx: Context,
  teamIndexes: number[],
  method: 'exact' | 'heuristic',
): MatchResult {
  const team = new Set(teamIndexes);
  const members = teamIndexes.map((i) => ctx.pool[i]!);

  const teamResult: TeamMember[] = members.map((c) => ({
    crewMemberId: c.id,
    name: c.name,
    email: c.email,
    upcomingMissions: c.load,
    covers: ctx.requirements.flatMap((r) =>
      qualifies(c, r)
        ? [
            {
              skillId: r.skillId,
              skill: r.skillName,
              level: c.skills[r.skillId]!,
              required: r.minLevel,
            },
          ]
        : [],
    ),
  }));

  const coverage: CoverageLine[] = ctx.requirements.map((r, ri) => {
    const contributing = ctx.qualifying[ri]!.filter((i) => team.has(i)).length;
    const met = Math.min(r.count, contributing);
    const line: CoverageLine = {
      skillId: r.skillId,
      skill: r.skillName,
      minLevel: r.minLevel,
      required: r.count,
      met,
    };
    if (met < r.count) {
      const blocked = Object.fromEntries(BLOCK_REASONS.map((reason) => [reason, 0])) as Record<
        BlockReason,
        number
      >;
      let qualifiedTotal = 0;
      for (const c of ctx.input.candidates) {
        if (!qualifies(c, r)) continue;
        qualifiedTotal++;
        const reason = ctx.blocked.get(c.id);
        if (reason) blocked[reason]++;
      }
      line.gap = { qualifiedTotal, blocked };
    }
    return line;
  });

  const alternates = ctx.requirements.map((r, ri) => {
    const candidates: Alternate[] = ctx.qualifying[ri]!.filter((i) => !team.has(i))
      .sort(
        (a, b) =>
          ctx.weight[a]! - ctx.weight[b]! || margin(ctx, b, ri) - margin(ctx, a, ri) || a - b,
      )
      .slice(0, MAX_ALTERNATES)
      .map((i) => {
        const c = ctx.pool[i]!;
        return {
          crewMemberId: c.id,
          name: c.name,
          email: c.email,
          upcomingMissions: c.load,
          level: c.skills[r.skillId]!,
        };
      });
    return { skillId: r.skillId, skill: r.skillName, candidates };
  });

  return {
    missionId: ctx.input.missionId,
    method,
    complete: scoreOf(ctx, team).unmet === 0,
    team: teamResult,
    coverage,
    alternates,
  };
}

/** How far above the requirement a pool member is, capped as in the skill-fit objective. */
const margin = (ctx: Context, poolIndex: number, ri: number): number =>
  Math.min(
    2,
    ctx.pool[poolIndex]!.skills[ctx.requirements[ri]!.skillId]! - ctx.requirements[ri]!.minLevel,
  );
