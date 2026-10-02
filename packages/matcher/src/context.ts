import {
  BLOCK_REASONS,
  type BlockReason,
  type MatchCandidate,
  type MatchInput,
  type MatchRequirement,
} from './types.js';

/** The input prepared once: who is eligible, who qualifies for what, and the weights of the objective. */
export interface Context {
  input: MatchInput;
  requirements: MatchRequirement[];
  /** Why each candidate is blocked, by the first reason that applies; absent when eligible. */
  blocked: Map<string, BlockReason>;
  /** Eligible candidates who qualify for at least one requirement, in ascending id order. */
  pool: MatchCandidate[];
  /** For each requirement, the pool indexes of the people who qualify. */
  qualifying: number[][];
  /** Workload cost of each pool member: (load + 1)². */
  weight: number[];
  /** Skill fit of each pool member: the margin above each requirement they cover, at most 2 each. */
  fit: number[];
  /** Position of each pool member in id order. */
  rank: number[];
}

export const MAX_MARGIN = 2;

export const qualifies = (c: MatchCandidate, r: MatchRequirement): boolean =>
  (c.skills[r.skillId] ?? 0) >= r.minLevel;

/** The first of the reasons that applies to the candidate (DESIGN.md §9.2), or undefined when they are eligible. */
export function blockReason(
  c: MatchCandidate,
  excluded: ReadonlySet<string>,
  cap: number,
): BlockReason | undefined {
  const applies: Record<BlockReason, boolean> = {
    UNAVAILABLE: c.unavailable,
    COMMITTED: c.committed,
    AT_CAPACITY: c.load >= cap,
    EXCLUDED: excluded.has(c.id),
  };
  return BLOCK_REASONS.find((reason) => applies[reason]);
}

const byId = (a: MatchCandidate, b: MatchCandidate) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function prepare(input: MatchInput): Context {
  const excluded = new Set(input.exclude);
  const blocked = new Map<string, BlockReason>();
  const eligible: MatchCandidate[] = [];
  for (const c of input.candidates) {
    const reason = blockReason(c, excluded, input.cap);
    if (reason) blocked.set(c.id, reason);
    else eligible.push(c);
  }
  const requirements = [...input.requirements].sort((a, b) =>
    a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0,
  );
  const pool = eligible.filter((c) => requirements.some((r) => qualifies(c, r))).sort(byId);
  const qualifying = requirements.map((r) => pool.flatMap((c, i) => (qualifies(c, r) ? [i] : [])));
  const weight = pool.map((c) => (c.load + 1) ** 2);
  const fit = pool.map((c) =>
    requirements.reduce(
      (sum, r) =>
        sum + (qualifies(c, r) ? Math.min(MAX_MARGIN, (c.skills[r.skillId] ?? 0) - r.minLevel) : 0),
      0,
    ),
  );
  const rank = pool.map((_, i) => i);
  return { input, requirements, blocked, pool, qualifying, weight, fit, rank };
}
