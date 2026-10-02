import type { Context } from './context.js';
import type { LinearConstraint, LinearModel, LinearTerm } from './types.js';

export type Pass = 'coverage' | 'workload' | 'fit' | 'rank';

/** What earlier passes fixed: the optimum each of them reached. */
export interface Fixed {
  unmet?: number;
  workload?: number;
  fit?: number;
}

const x = (i: number) => `x${i}`;
const u = (r: number) => `u${r}`;

/**
 * The set multi-cover model of DESIGN.md §9.3. `x_i` puts pool member i on the team; `u_r` is the
 * unmet count of requirement r. The four passes share the constraints and differ in the objective;
 * each later pass is bounded by the optimum of the earlier ones, which is what makes the priorities
 * lexicographic without any large weights.
 */
export function buildModel(ctx: Context, pass: Pass, fixed: Fixed): LinearModel {
  const coverage: LinearConstraint[] = ctx.requirements.map((r, ri) => ({
    name: `cover${ri}`,
    terms: [
      ...ctx.qualifying[ri]!.map((i) => ({ variable: x(i), coefficient: 1 })),
      { variable: u(ri), coefficient: 1 },
    ],
    operator: '>=',
    rhs: r.count,
  }));

  const sum = (coefficients: number[]): LinearTerm[] =>
    coefficients
      .map((coefficient, i) => ({ variable: x(i), coefficient }))
      .filter((t) => t.coefficient !== 0);
  const unmet: LinearTerm[] = ctx.requirements.map((_, ri) => ({
    variable: u(ri),
    coefficient: 1,
  }));

  const constraints = [...coverage];
  if (fixed.unmet !== undefined)
    constraints.push({ name: 'unmet', terms: unmet, operator: '<=', rhs: fixed.unmet });
  if (fixed.workload !== undefined)
    constraints.push({
      name: 'workload',
      terms: sum(ctx.weight),
      operator: '<=',
      rhs: fixed.workload,
    });
  if (fixed.fit !== undefined)
    constraints.push({ name: 'fit', terms: sum(ctx.fit), operator: '>=', rhs: fixed.fit });

  const objective: Record<Pass, { sense: 'min' | 'max'; terms: LinearTerm[] }> = {
    coverage: { sense: 'min', terms: unmet },
    workload: { sense: 'min', terms: sum(ctx.weight) },
    fit: { sense: 'max', terms: sum(ctx.fit) },
    rank: { sense: 'min', terms: sum(ctx.rank) },
  };

  return {
    sense: objective[pass].sense,
    objective: objective[pass].terms,
    constraints,
    binary: ctx.pool.map((_, i) => x(i)),
    integer: ctx.requirements.map((_, ri) => u(ri)),
  };
}

export const variableIndex = (name: string): number => Number(name.slice(1));
export { x as teamVariable };
