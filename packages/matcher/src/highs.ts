import highsModule from 'highs';
import type { LinearModel, LinearTerm, SolveOutcome, Solver } from './types.js';

/**
 * The HiGHS (WebAssembly) adapter of the `Solver` port, in its own entry point because loading the
 * module reads its `.wasm` file: that I/O stays out of the pure engine. Single-threaded and
 * seed-fixed, so the same model always gives the same answer.
 */
export async function createHighsSolver(): Promise<Solver> {
  // The package is typed as CommonJS but loads as an ES module, whose default export is the loader.
  const highsLoader = highsModule as unknown as typeof highsModule.default;
  const highs = await highsLoader();
  return {
    solve(model, { timeLimitSeconds }) {
      if (model.objective.length === 0 && model.binary.length === 0)
        return { status: 'optimal', objective: 0, values: {} };
      let solution;
      try {
        solution = highs.solve(toLp(model), {
          time_limit: timeLimitSeconds,
          threads: 1,
          random_seed: 0,
          mip_rel_gap: 0,
          mip_abs_gap: 0,
          output_flag: false,
        });
      } catch {
        return { status: 'error' };
      }
      return outcomeOf(solution as unknown as HighsResult);
    },
  };
}

/** The parts of HiGHS's answer that this adapter reads; `Columns` is only used when the status is Optimal. */
interface HighsResult {
  Status: string;
  ObjectiveValue: number;
  Columns: Record<string, { Primal: number }>;
}

function outcomeOf(solution: HighsResult): SolveOutcome {
  switch (solution.Status) {
    case 'Optimal':
      return {
        status: 'optimal',
        objective: solution.ObjectiveValue,
        values: Object.fromEntries(
          Object.entries(solution.Columns).map(([name, column]) => [name, column.Primal]),
        ),
      };
    case 'Time limit reached':
      return { status: 'time_limit' };
    case 'Infeasible':
      return { status: 'infeasible' };
    default:
      return { status: 'error' };
  }
}

const expression = (terms: LinearTerm[]): string => {
  const merged = new Map<string, number>();
  for (const t of terms) merged.set(t.variable, (merged.get(t.variable) ?? 0) + t.coefficient);
  const parts = [...merged]
    .filter(([, c]) => c !== 0)
    .map(([v, c]) => `${c < 0 ? '-' : '+'} ${Math.abs(c)} ${v}`);
  return parts.length ? parts.join(' ').replace(/^\+ /, '') : '0 x0';
};

/** The model in CPLEX LP format, which HiGHS reads. */
export function toLp(model: LinearModel): string {
  const lines = [
    model.sense === 'min' ? 'Minimize' : 'Maximize',
    ` obj: ${expression(model.objective)}`,
    'Subject To',
  ];
  for (const c of model.constraints)
    lines.push(` ${c.name}: ${expression(c.terms)} ${c.operator} ${c.rhs}`);
  lines.push('Bounds');
  for (const v of model.integer) lines.push(` 0 <= ${v}`);
  for (const v of model.binary) lines.push(` 0 <= ${v} <= 1`);
  if (model.binary.length) lines.push('Binary', ` ${model.binary.join(' ')}`);
  if (model.integer.length) lines.push('General', ` ${model.integer.join(' ')}`);
  lines.push('End');
  return lines.join('\n');
}
