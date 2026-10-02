import type { Context } from './context.js';
import { qualifies } from './context.js';

/** The four objectives of a team, in priority order: unmet slots, workload cost, skill fit (to maximise), id rank. */
export interface Score {
  unmet: number;
  workload: number;
  fit: number;
  rank: number;
}

export function scoreOf(ctx: Context, team: ReadonlySet<number>): Score {
  let unmet = 0;
  ctx.requirements.forEach((r, ri) => {
    const have = ctx.qualifying[ri]!.filter((i) => team.has(i)).length;
    unmet += Math.max(0, r.count - have);
  });
  let workload = 0;
  let fit = 0;
  let rank = 0;
  for (const i of team) {
    workload += ctx.weight[i]!;
    fit += ctx.fit[i]!;
    rank += ctx.rank[i]!;
  }
  return { unmet, workload, fit, rank };
}

/** True when `a` is a strictly better team than `b`: fewer unmet, then cheaper, then better fit, then lower ids. */
export function better(a: Score, b: Score): boolean {
  if (a.unmet !== b.unmet) return a.unmet < b.unmet;
  if (a.workload !== b.workload) return a.workload < b.workload;
  if (a.fit !== b.fit) return a.fit > b.fit;
  return a.rank < b.rank;
}

export const qualifiesFor = qualifies;
