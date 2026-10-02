import { createHighsSolver } from './highs.js';
import type {
  LinearModel,
  MatchCandidate,
  MatchInput,
  MatchRequirement,
  SolveOutcome,
  Solver,
} from './types.js';

let shared: Promise<Solver> | undefined;
/** One HiGHS instance for a test file. */
export const highs = (): Promise<Solver> => (shared ??= createHighsSolver());

/** A solver that never answers in time, as when the limit is hit. */
export const timingOut: Solver = { solve: () => ({ status: 'time_limit' }) };
export const failing: Solver = { solve: () => ({ status: 'error' }) };
/** Answers like the real one for `passes` passes, then times out. */
export const timingOutAfter = (real: Solver, passes: number): Solver => {
  let calls = 0;
  return {
    solve(model: LinearModel, options: { timeLimitSeconds: number }): SolveOutcome {
      return ++calls > passes ? { status: 'time_limit' } : real.solve(model, options);
    },
  };
};

export const candidate = (
  id: string,
  skills: Record<string, number>,
  over: Partial<MatchCandidate> = {},
): MatchCandidate => ({
  id,
  name: `Name ${id}`,
  email: `${id}@lrl.space`,
  load: 0,
  skills,
  unavailable: false,
  committed: false,
  ...over,
});

export const requirement = (
  skillId: string,
  minLevel: number,
  count: number,
): MatchRequirement => ({
  skillId,
  skillName: `Skill ${skillId}`,
  minLevel,
  count,
});

export const input = (over: Partial<MatchInput> = {}): MatchInput => ({
  missionId: 'mission-1',
  requirements: [],
  candidates: [],
  exclude: [],
  cap: 3,
  ...over,
});
