import type { Context } from './context.js';
import { better, scoreOf } from './score.js';

/**
 * The fallback when the solver times out (DESIGN.md §9.3): greedily add the person covering the
 * most still-unmet requirement slots (ties: lowest load, then best fit, then lowest id), then
 * improve with 1-swap local search (drop a member, or swap one member for one outsider) while the
 * team gets better. Deterministic, and always a valid team.
 */
export function solveHeuristic(ctx: Context): number[] {
  const team = new Set<number>();
  const remaining = ctx.requirements.map((r) => r.count);

  for (;;) {
    let best = -1;
    let bestCovered = 0;
    for (let i = 0; i < ctx.pool.length; i++) {
      if (team.has(i)) continue;
      const covered = ctx.requirements.reduce(
        (n, _, ri) => n + (remaining[ri]! > 0 && ctx.qualifying[ri]!.includes(i) ? 1 : 0),
        0,
      );
      if (covered === 0) continue;
      if (
        covered > bestCovered ||
        (covered === bestCovered &&
          best >= 0 &&
          (ctx.weight[i]! < ctx.weight[best]! ||
            (ctx.weight[i] === ctx.weight[best] && ctx.fit[i]! > ctx.fit[best]!)))
      ) {
        best = i;
        bestCovered = covered;
      }
    }
    if (best < 0) break;
    team.add(best);
    ctx.requirements.forEach((_, ri) => {
      if (ctx.qualifying[ri]!.includes(best)) remaining[ri] = Math.max(0, remaining[ri]! - 1);
    });
  }

  // 1-swap local search. Candidates are tried in index (id) order, so the result is deterministic.
  let improved = true;
  while (improved) {
    improved = false;
    const current = scoreOf(ctx, team);
    for (const member of [...team].sort((a, b) => a - b)) {
      const without = new Set(team);
      without.delete(member);
      if (better(scoreOf(ctx, without), current)) {
        team.delete(member);
        improved = true;
        break;
      }
      let swapped = false;
      for (let i = 0; i < ctx.pool.length && !swapped; i++) {
        if (team.has(i)) continue;
        const next = new Set(without);
        next.add(i);
        if (better(scoreOf(ctx, next), current)) {
          team.delete(member);
          team.add(i);
          swapped = true;
        }
      }
      if (swapped) {
        improved = true;
        break;
      }
    }
  }
  return [...team].sort((a, b) => a - b);
}
