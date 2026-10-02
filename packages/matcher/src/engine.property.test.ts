import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { match } from './engine.js';
import { candidate, highs, requirement, timingOut } from './test-support.js';
import type { MatchCandidate, MatchInput, MatchResult, Solver } from './types.js';
import { BLOCK_REASONS } from './types.js';

let solver: Solver;
beforeAll(async () => {
  solver = await highs();
});

const SKILLS = ['s0', 's1', 's2'];

const candidateArb = (index: number): fc.Arbitrary<MatchCandidate> =>
  fc
    .record({
      load: fc.integer({ min: 0, max: 4 }),
      skills: fc.dictionary(fc.constantFrom(...SKILLS), fc.integer({ min: 1, max: 5 })),
      unavailable: fc.boolean(),
      committed: fc.boolean(),
    })
    .map((c) =>
      candidate(`c${String(index).padStart(2, '0')}`, c.skills, {
        load: c.load,
        unavailable: c.unavailable,
        committed: c.committed,
      }),
    );

/** Small instances, in the range where a brute-force search over every team is cheap. */
const inputArb: fc.Arbitrary<MatchInput> = fc
  .record({
    n: fc.integer({ min: 0, max: 9 }),
    requirements: fc
      .uniqueArray(fc.constantFrom(...SKILLS), { minLength: 0, maxLength: 3 })
      .chain((skills) =>
        fc.tuple(
          ...skills.map((s) =>
            fc
              .record({
                minLevel: fc.integer({ min: 1, max: 5 }),
                count: fc.integer({ min: 1, max: 3 }),
              })
              .map((r) => requirement(s, r.minLevel, r.count)),
          ),
        ),
      ),
    cap: fc.integer({ min: 1, max: 5 }),
  })
  .chain(({ n, requirements, cap }) =>
    fc
      .tuple(...Array.from({ length: n }, (_, i) => candidateArb(i)))
      .chain((candidates) =>
        fc
          .subarray(candidates.map((c) => c.id))
          .map((exclude) => ({ missionId: 'm', requirements, candidates, exclude, cap })),
      ),
  );

// ---------------------------------------------------------------- the oracle

interface Objectives {
  unmet: number;
  workload: number;
  fit: number;
  rank: number;
}

/** Everything about an instance computed the slow, obvious way, independently of the engine. */
function oracle(input: MatchInput) {
  const reasons = (c: MatchCandidate) =>
    [
      c.unavailable && 'UNAVAILABLE',
      c.committed && 'COMMITTED',
      c.load >= input.cap && 'AT_CAPACITY',
      input.exclude.includes(c.id) && 'EXCLUDED',
    ].filter(Boolean) as string[];
  const qualifies = (c: MatchCandidate, r: (typeof input.requirements)[number]) =>
    (c.skills[r.skillId] ?? 0) >= r.minLevel;
  const eligible = input.candidates.filter((c) => reasons(c).length === 0);
  // People who qualify for nothing never help any objective, so the search is over those who qualify for something.
  const pool = eligible
    .filter((c) => input.requirements.some((r) => qualifies(c, r)))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const objectives = (team: MatchCandidate[]): Objectives => {
    let unmet = 0;
    for (const r of input.requirements)
      unmet += Math.max(0, r.count - team.filter((c) => qualifies(c, r)).length);
    return {
      unmet,
      workload: team.reduce((s, c) => s + (c.load + 1) ** 2, 0),
      fit: team.reduce(
        (s, c) =>
          s +
          input.requirements.reduce(
            (f, r) => f + (qualifies(c, r) ? Math.min(2, c.skills[r.skillId]! - r.minLevel) : 0),
            0,
          ),
        0,
      ),
      rank: team.reduce((s, c) => s + pool.indexOf(c), 0),
    };
  };
  const betterThan = (a: Objectives, b: Objectives) =>
    a.unmet !== b.unmet
      ? a.unmet < b.unmet
      : a.workload !== b.workload
        ? a.workload < b.workload
        : a.fit !== b.fit
          ? a.fit > b.fit
          : a.rank < b.rank;

  let best: Objectives | undefined;
  for (let mask = 0; mask < 1 << pool.length; mask++) {
    const team = pool.filter((_, i) => mask & (1 << i));
    const score = objectives(team);
    if (!best || betterThan(score, best)) best = score;
  }
  return { reasons, qualifies, eligible, pool, objectives, best: best! };
}

const teamOf = (input: MatchInput, result: MatchResult) =>
  result.team.map((m) => input.candidates.find((c) => c.id === m.crewMemberId)!);

describe('against the brute-force oracle', () => {
  it('finds the optimum of all four objectives, in priority order', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const o = oracle(input);
        const result = match(input, { solver });
        expect(result.method).toBe('exact');
        expect(o.objectives(teamOf(input, result))).toEqual(o.best);
      }),
      { numRuns: 250 },
    );
  });

  it('only ever selects eligible people who qualify for something, never an excluded or blocked one', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const o = oracle(input);
        const result = match(input, { solver });
        for (const member of teamOf(input, result)) {
          expect(o.reasons(member)).toEqual([]);
          expect(input.exclude).not.toContain(member.id);
          expect(input.requirements.some((r) => o.qualifies(member, r))).toBe(true);
        }
        expect(new Set(result.team.map((m) => m.crewMemberId)).size).toBe(result.team.length);
      }),
      { numRuns: 150 },
    );
  });

  it('reports coverage and completeness that agree with the team', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const o = oracle(input);
        const result = match(input, { solver });
        const team = teamOf(input, result);
        expect(result.coverage).toHaveLength(input.requirements.length);
        for (const line of result.coverage) {
          const r = input.requirements.find((x) => x.skillId === line.skillId)!;
          const contributing = team.filter((c) => o.qualifies(c, r)).length;
          expect(line.required).toBe(r.count);
          expect(line.minLevel).toBe(r.minLevel);
          expect(line.met).toBe(Math.min(r.count, contributing));
          expect(line.gap === undefined).toBe(line.met >= line.required);
        }
        expect(result.complete).toBe(result.coverage.every((l) => l.met === l.required));
        expect(result.complete).toBe(o.best.unmet === 0);
      }),
      { numRuns: 150 },
    );
  });

  it('explains every gap so that the numbers reconcile: qualified = contributing + blocked + not selected', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const o = oracle(input);
        const result = match(input, { solver });
        const team = teamOf(input, result);
        for (const line of result.coverage) {
          if (!line.gap) continue;
          const r = input.requirements.find((x) => x.skillId === line.skillId)!;
          const qualified = input.candidates.filter((c) => o.qualifies(c, r));
          const contributing = team.filter((c) => o.qualifies(c, r)).length;
          const blockedTotal = qualified.filter((c) => o.reasons(c).length > 0).length;
          const notSelected = qualified.filter(
            (c) => o.reasons(c).length === 0 && !team.includes(c),
          ).length;
          expect(line.gap.qualifiedTotal).toBe(qualified.length);
          expect(Object.keys(line.gap.blocked).sort()).toEqual([...BLOCK_REASONS].sort());
          expect(Object.values(line.gap.blocked).reduce((a, b) => a + b, 0)).toBe(blockedTotal);
          expect(line.gap.qualifiedTotal).toBe(contributing + blockedTotal + notSelected);
          // The exact solution leaves nobody eligible and qualified unselected when a requirement is unmet.
          expect(notSelected).toBe(0);
          // Each blocked person is counted once, under the first reason that applies.
          for (const reason of BLOCK_REASONS) {
            const expected = qualified.filter((c) => o.reasons(c)[0] === reason).length;
            expect(line.gap.blocked[reason]).toBe(expected);
          }
        }
      }),
      { numRuns: 150 },
    );
  });

  it('is deterministic: the same instance, in any order, gives byte-identical output', () => {
    fc.assert(
      fc.property(inputArb, fc.infiniteStream(fc.nat()), (input, entropy) => {
        const first = JSON.stringify(match(input, { solver }));
        const it = entropy[Symbol.iterator]();
        const shuffle = <T>(xs: T[]): T[] =>
          xs
            .map((x) => [it.next().value as number, x] as const)
            .sort((a, b) => a[0] - b[0])
            .map(([, x]) => x);
        const permuted = {
          ...input,
          candidates: shuffle(input.candidates),
          requirements: shuffle(input.requirements),
          exclude: shuffle(input.exclude),
        };
        expect(JSON.stringify(match(permuted, { solver }))).toBe(first);
        expect(JSON.stringify(match(input, { solver }))).toBe(first);
      }),
      { numRuns: 100 },
    );
  });

  it('never exposes blocked people: none of their ids, names or emails appear in the result', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const o = oracle(input);
        const text = JSON.stringify(match(input, { solver }));
        for (const c of input.candidates.filter((x) => o.reasons(x).length > 0)) {
          expect(text).not.toContain(`"${c.id}"`);
          expect(text).not.toContain(c.email);
          expect(text).not.toContain(c.name!);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('lists at most three alternates per requirement: eligible, qualified, outside the team', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const o = oracle(input);
        const result = match(input, { solver });
        const team = new Set(result.team.map((m) => m.crewMemberId));
        expect(result.alternates).toHaveLength(input.requirements.length);
        for (const entry of result.alternates) {
          const r = input.requirements.find((x) => x.skillId === entry.skillId)!;
          expect(entry.candidates.length).toBeLessThanOrEqual(3);
          for (const a of entry.candidates) {
            const c = input.candidates.find((x) => x.id === a.crewMemberId)!;
            expect(team.has(c.id)).toBe(false);
            expect(o.reasons(c)).toEqual([]);
            expect(o.qualifies(c, r)).toBe(true);
          }
          const available = o.pool.filter((c) => o.qualifies(c, r) && !team.has(c.id)).length;
          expect(entry.candidates.length).toBe(Math.min(3, available));
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('the heuristic fallback, against the same oracle', () => {
  it('always returns a valid team that is no better than the optimum, deterministically', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const o = oracle(input);
        const result = match(input, { solver: timingOut });
        // With nobody qualified, the empty team is trivially optimal and the solver is never asked.
        expect(result.method).toBe(o.pool.length === 0 ? 'exact' : 'heuristic');
        const team = teamOf(input, result);
        for (const member of team) expect(o.reasons(member)).toEqual([]);
        expect(new Set(team.map((c) => c.id)).size).toBe(team.length);
        const score = o.objectives(team);
        expect(score.unmet).toBeGreaterThanOrEqual(o.best.unmet);
        expect(JSON.stringify(match(input, { solver: timingOut }))).toBe(JSON.stringify(result));
        expect(result.complete).toBe(score.unmet === 0);
      }),
      { numRuns: 200 },
    );
  });

  it('meets every requirement whenever a single requirement per person makes it easy (count-only instances)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 0, max: 8 }), (count, n) => {
        const input: MatchInput = {
          missionId: 'm',
          requirements: [requirement('s0', 1, count)],
          candidates: Array.from({ length: n }, (_, i) =>
            candidate(`c${i}`, { s0: 1 }, { load: i % 3 }),
          ),
          exclude: [],
          cap: 5,
        };
        const result = match(input, { solver: timingOut });
        expect(result.team.length).toBe(Math.min(count, n));
        expect(result.complete).toBe(n >= count);
      }),
      { numRuns: 60 },
    );
  });
});
