import { prepare } from './context.js';
import { solveExact } from './exact.js';
import { buildResult } from './explain.js';
import { solveHeuristic } from './heuristic.js';
import type { MatchInput, MatchResult, Solver } from './types.js';

export interface MatchOptions {
  solver: Solver;
  /** Time limit of each of the solver's passes (DESIGN.md §9.3). */
  timeLimitSeconds?: number;
}

export const DEFAULT_TIME_LIMIT_SECONDS = 2;

/**
 * Proposes the best whole team for a mission: it meets every requirement if at all possible, then
 * spreads workload (the smallest, least-loaded team), then prefers the better skill fit, then lower
 * ids. Exact through the solver; if that times out or fails, the greedy heuristic answers and the
 * result says so. Infeasible input yields the best partial team with its gaps, never an error.
 * Pure: no I/O of its own.
 */
export function match(input: MatchInput, options: MatchOptions): MatchResult {
  const ctx = prepare(input);
  const exact = solveExact(
    ctx,
    options.solver,
    options.timeLimitSeconds ?? DEFAULT_TIME_LIMIT_SECONDS,
  );
  if (exact) return buildResult(ctx, exact, 'exact');
  return buildResult(ctx, solveHeuristic(ctx), 'heuristic');
}
