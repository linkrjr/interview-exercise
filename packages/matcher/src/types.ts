/** Why a person cannot be on the team (DESIGN.md §9.2). */
export type BlockReason = 'UNAVAILABLE' | 'COMMITTED' | 'AT_CAPACITY' | 'EXCLUDED';

/** The order in which a person's reasons are reported: each blocked person is counted once, under the first that applies. */
export const BLOCK_REASONS: readonly BlockReason[] = [
  'UNAVAILABLE',
  'COMMITTED',
  'AT_CAPACITY',
  'EXCLUDED',
];

export interface MatchRequirement {
  skillId: string;
  skillName: string;
  minLevel: number;
  count: number;
}

/** An active Crew Member of the organisation, with the facts the rules need. */
export interface MatchCandidate {
  id: string;
  name: string | null;
  email: string;
  /** Upcoming missions: live holds (DESIGN.md §8). */
  load: number;
  /** Skill level (1 to 5) by skill id. */
  skills: Record<string, number>;
  /** Has an unavailability range overlapping the mission dates. */
  unavailable: boolean;
  /** Has a live hold overlapping the mission dates. */
  committed: boolean;
}

export interface MatchInput {
  missionId: string;
  requirements: MatchRequirement[];
  candidates: MatchCandidate[];
  /** Candidate ids the Lead excludes. */
  exclude: string[];
  /** The organisation's cap on upcoming missions per person. */
  cap: number;
}

export interface TeamMember {
  crewMemberId: string;
  name: string | null;
  email: string;
  upcomingMissions: number;
  /** The requirements this person qualifies for, with their level and the level required. */
  covers: Array<{ skillId: string; skill: string; level: number; required: number }>;
}

export interface CoverageLine {
  skillId: string;
  skill: string;
  minLevel: number;
  required: number;
  /** Team members who qualify, at most `required`. */
  met: number;
  /** Present only when the requirement is not met: what blocks the qualified people (counts, never names). */
  gap?: {
    qualifiedTotal: number;
    blocked: Record<BlockReason, number>;
  };
}

export interface Alternate {
  crewMemberId: string;
  name: string | null;
  email: string;
  upcomingMissions: number;
  level: number;
}

export interface MatchResult {
  missionId: string;
  method: 'exact' | 'heuristic';
  /** Every requirement is met. */
  complete: boolean;
  team: TeamMember[];
  coverage: CoverageLine[];
  /** Next-best eligible candidates for each requirement, up to three. */
  alternates: Array<{ skillId: string; skill: string; candidates: Alternate[] }>;
}

// ---------------------------------------------------------------- solver port

export interface LinearTerm {
  variable: string;
  coefficient: number;
}

export interface LinearConstraint {
  name: string;
  terms: LinearTerm[];
  operator: '>=' | '<=';
  rhs: number;
}

/** A small integer program: binary variables, non-negative integer variables, linear constraints. */
export interface LinearModel {
  sense: 'min' | 'max';
  objective: LinearTerm[];
  constraints: LinearConstraint[];
  binary: string[];
  integer: string[];
}

export type SolveOutcome =
  | { status: 'optimal'; objective: number; values: Record<string, number> }
  | { status: 'time_limit' | 'infeasible' | 'error' };

/**
 * What the engine needs from an integer-programming solver. The HiGHS adapter implements it
 * (`@mc/matcher/highs`); the engine itself never touches the solver's runtime, so it stays pure.
 */
export interface Solver {
  solve(model: LinearModel, options: { timeLimitSeconds: number }): SolveOutcome;
}
