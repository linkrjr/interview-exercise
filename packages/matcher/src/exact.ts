import type { Context } from './context.js';
import { buildModel, variableIndex, type Fixed } from './model.js';
import type { Solver } from './types.js';

/**
 * Solves the model in four passes, each bounded by the optimum of the one before: unmet slots
 * (coverage), workload cost, skill fit, and finally a preference for lower ids, which makes the
 * answer canonical for a given input. Returns the pool indexes on the team, or `undefined` when
 * the solver ran out of time or failed (the caller then falls back to the heuristic).
 */
export function solveExact(
  ctx: Context,
  solver: Solver,
  timeLimitSeconds: number,
): number[] | undefined {
  if (ctx.pool.length === 0) return [];

  const fixed: Fixed = {};
  const run = (pass: 'coverage' | 'workload' | 'fit' | 'rank') =>
    solver.solve(buildModel(ctx, pass, fixed), { timeLimitSeconds });

  const coverage = run('coverage');
  if (coverage.status !== 'optimal') return undefined;
  fixed.unmet = Math.round(coverage.objective);

  const workload = run('workload');
  if (workload.status !== 'optimal') return undefined;
  fixed.workload = Math.round(workload.objective);

  const fit = run('fit');
  if (fit.status !== 'optimal') return undefined;
  fixed.fit = Math.round(fit.objective);

  const rank = run('rank');
  if (rank.status !== 'optimal') return undefined;
  return Object.entries(rank.values)
    .filter(([name, value]) => name.startsWith('x') && value > 0.5)
    .map(([name]) => variableIndex(name))
    .sort((a, b) => a - b);
}
