import { beforeAll, describe, expect, it } from 'vitest';
import { match } from './engine.js';
import {
  candidate,
  failing,
  highs,
  input,
  requirement,
  timingOut,
  timingOutAfter,
} from './test-support.js';
import type { MatchResult, Solver } from './types.js';

let solver: Solver;
beforeAll(async () => {
  solver = await highs();
});

const ids = (r: MatchResult) => r.team.map((m) => m.crewMemberId);

describe('the team', () => {
  it('meets the requirement with the least-loaded people, leaving the busy one as an alternate', () => {
    const r = match(
      input({
        requirements: [requirement('med', 3, 2)],
        candidates: [
          candidate('a', { med: 4 }),
          candidate('b', { med: 5 }, { load: 2 }),
          candidate('c', { med: 3 }, { unavailable: true }),
          candidate('d', { med: 3 }),
        ],
      }),
      { solver },
    );
    expect(r).toMatchObject({ method: 'exact', complete: true });
    expect(ids(r)).toEqual(['a', 'd']);
    expect(r.team[0]).toEqual({
      crewMemberId: 'a',
      name: 'Name a',
      email: 'a@lrl.space',
      upcomingMissions: 0,
      covers: [{ skillId: 'med', skill: 'Skill med', level: 4, required: 3 }],
    });
    expect(r.coverage).toEqual([
      { skillId: 'med', skill: 'Skill med', minLevel: 3, required: 2, met: 2 },
    ]);
    expect(r.alternates).toEqual([
      {
        skillId: 'med',
        skill: 'Skill med',
        candidates: [
          {
            crewMemberId: 'b',
            name: 'Name b',
            email: 'b@lrl.space',
            upcomingMissions: 2,
            level: 5,
          },
        ],
      },
    ]);
  });

  it('uses the smallest team: one person who covers several requirements beats two specialists', () => {
    const r = match(
      input({
        requirements: [requirement('med', 3, 1), requirement('pil', 4, 1)],
        candidates: [
          candidate('all', { med: 4, pil: 5 }),
          candidate('m', { med: 5 }),
          candidate('p', { pil: 5 }),
        ],
      }),
      { solver },
    );
    expect(ids(r)).toEqual(['all']);
    expect(r.team[0]!.covers.map((c) => c.skill)).toEqual(['Skill med', 'Skill pil']);
    expect(r.complete).toBe(true);
  });

  it('puts coverage before workload: a heavily loaded person is chosen when nobody else can cover', () => {
    const r = match(
      input({
        requirements: [requirement('med', 3, 1)],
        candidates: [candidate('busy', { med: 4 }, { load: 2 }), candidate('weak', { med: 2 })],
      }),
      { solver },
    );
    expect(ids(r)).toEqual(['busy']);
    expect(r.complete).toBe(true);
  });

  it('puts workload before skill fit: the lighter load wins even with a worse fit', () => {
    const r = match(
      input({
        requirements: [requirement('med', 1, 1)],
        candidates: [
          candidate('expert', { med: 5 }, { load: 1 }),
          candidate('fresh', { med: 1 }, { load: 0 }),
        ],
      }),
      { solver },
    );
    expect(ids(r)).toEqual(['fresh']);
  });

  it('prefers the better fit when the workload is equal, counting the margin up to 2 per requirement', () => {
    const r = match(
      input({
        requirements: [requirement('med', 1, 1)],
        candidates: [
          candidate('ok', { med: 2 }),
          candidate('good', { med: 3 }),
          candidate('great', { med: 5 }),
        ],
      }),
      { solver },
    );
    // margins: ok 1, good 2, great 4 capped to 2: good and great tie on fit, so the lower id decides.
    expect(ids(r)).toEqual(['good']);
  });

  it('breaks the last ties by lower id', () => {
    const r = match(
      input({
        requirements: [requirement('med', 3, 1)],
        candidates: [
          candidate('c', { med: 3 }),
          candidate('b', { med: 3 }),
          candidate('a', { med: 3 }),
        ],
      }),
      { solver },
    );
    expect(ids(r)).toEqual(['a']);
  });

  it('treats a load at the cap as a block, and one below it as available', () => {
    const r = match(
      input({
        cap: 2,
        requirements: [requirement('med', 1, 2)],
        candidates: [
          candidate('full', { med: 3 }, { load: 2 }),
          candidate('over', { med: 3 }, { load: 5 }),
          candidate('ok', { med: 3 }, { load: 1 }),
        ],
      }),
      { solver },
    );
    expect(ids(r)).toEqual(['ok']);
    expect(r.complete).toBe(false);
    expect(r.coverage[0]).toMatchObject({
      met: 1,
      required: 2,
      gap: { qualifiedTotal: 3, blocked: { AT_CAPACITY: 2 } },
    });
  });

  it('never selects an excluded person, and never an unavailable or committed one', () => {
    const r = match(
      input({
        exclude: ['x'],
        requirements: [requirement('med', 1, 3)],
        candidates: [
          candidate('x', { med: 5 }),
          candidate('u', { med: 5 }, { unavailable: true }),
          candidate('c', { med: 5 }, { committed: true }),
          candidate('ok', { med: 1 }),
        ],
      }),
      { solver },
    );
    expect(ids(r)).toEqual(['ok']);
  });

  it('proposes nobody extra once the requirements are met', () => {
    const r = match(
      input({
        requirements: [requirement('med', 1, 1)],
        candidates: [candidate('a', { med: 1 }), candidate('b', { med: 1 })],
      }),
      { solver },
    );
    expect(r.team).toHaveLength(1);
  });

  it('does not count people with no skill for any requirement', () => {
    const r = match(
      input({
        requirements: [requirement('med', 1, 1)],
        candidates: [candidate('chef', { cook: 5 }), candidate('doc', { med: 1 })],
      }),
      { solver },
    );
    expect(ids(r)).toEqual(['doc']);
  });
});

describe('when the requirements cannot all be met', () => {
  it('returns the best partial team with the gap explained by counts, each blocked person counted once', () => {
    const r = match(
      input({
        exclude: ['ex', 'both-ex'],
        cap: 3,
        requirements: [requirement('med', 3, 4)],
        candidates: [
          candidate('free', { med: 3 }),
          candidate('away', { med: 4 }, { unavailable: true }),
          candidate('away2', { med: 5 }, { unavailable: true }),
          candidate('booked', { med: 3 }, { committed: true }),
          candidate('both', { med: 3 }, { unavailable: true, committed: true }), // first reason wins: UNAVAILABLE
          candidate('maxed', { med: 3 }, { load: 3 }),
          candidate('ex', { med: 3 }),
          candidate('both-ex', { med: 3 }, { load: 3 }), // AT_CAPACITY comes before EXCLUDED
          candidate('weak', { med: 2 }), // not qualified: not counted at all
        ],
      }),
      { solver },
    );
    expect(ids(r)).toEqual(['free']);
    expect(r.complete).toBe(false);
    expect(r.coverage[0]).toEqual({
      skillId: 'med',
      skill: 'Skill med',
      minLevel: 3,
      required: 4,
      met: 1,
      gap: {
        qualifiedTotal: 8,
        blocked: { UNAVAILABLE: 3, COMMITTED: 1, AT_CAPACITY: 2, EXCLUDED: 1 },
      },
    });
    // qualified = contributing + blocked + not selected
    const blocked = Object.values(r.coverage[0]!.gap!.blocked).reduce((a, b) => a + b, 0);
    expect(8).toBe(1 + blocked + 0);
  });

  it('excluding everyone qualified yields an empty, incomplete team with the exclusions counted', () => {
    const r = match(
      input({
        exclude: ['a', 'b'],
        requirements: [requirement('med', 1, 1)],
        candidates: [candidate('a', { med: 3 }), candidate('b', { med: 4 })],
      }),
      { solver },
    );
    expect(r).toMatchObject({ method: 'exact', complete: false, team: [] });
    expect(r.coverage[0]!.gap).toEqual({
      qualifiedTotal: 2,
      blocked: { UNAVAILABLE: 0, COMMITTED: 0, AT_CAPACITY: 0, EXCLUDED: 2 },
    });
    expect(r.alternates).toEqual([{ skillId: 'med', skill: 'Skill med', candidates: [] }]);
  });

  it('covers what it can of several requirements', () => {
    const r = match(
      input({
        requirements: [requirement('med', 3, 1), requirement('pil', 3, 2)],
        candidates: [candidate('doc', { med: 4 }), candidate('pilot', { pil: 3 })],
      }),
      { solver },
    );
    expect(ids(r).sort()).toEqual(['doc', 'pilot']);
    expect(r.coverage.map((c) => [c.skillId, c.met, c.required])).toEqual([
      ['med', 1, 1],
      ['pil', 1, 2],
    ]);
    expect(r.coverage.find((c) => c.skillId === 'med')!.gap).toBeUndefined();
    expect(r.coverage.find((c) => c.skillId === 'pil')!.gap).toMatchObject({ qualifiedTotal: 1 });
  });

  it('handles no candidates and no requirements without error', () => {
    expect(match(input({ requirements: [requirement('med', 1, 1)] }), { solver })).toMatchObject({
      complete: false,
      team: [],
      method: 'exact',
    });
    expect(match(input({ candidates: [candidate('a', { med: 3 })] }), { solver })).toMatchObject({
      complete: true,
      team: [],
      coverage: [],
    });
  });
});

describe('alternates', () => {
  it('lists up to three eligible people outside the team, lightest load first, then best fit, then id', () => {
    const r = match(
      input({
        requirements: [requirement('med', 1, 1)],
        candidates: [
          candidate('pick', { med: 1 }),
          candidate('a', { med: 2 }, { load: 1 }),
          candidate('b', { med: 4 }, { load: 1 }),
          candidate('c', { med: 3 }, { load: 0 }),
          candidate('d', { med: 3 }, { load: 2 }),
          candidate('e', { med: 5 }, { load: 3 }),
          candidate('away', { med: 5 }, { unavailable: true }),
        ],
      }),
      { solver },
    );
    expect(ids(r)).toEqual(['c']); // load 0 and the better fit of the unloaded two? 'pick' (margin 0) vs 'c' (margin 2)
    expect(r.alternates[0]!.candidates.map((x) => x.crewMemberId)).toEqual(['pick', 'b', 'a']);
  });

  it('never lists blocked people, anywhere in the result', () => {
    const r = match(
      input({
        exclude: ['ex'],
        requirements: [requirement('med', 1, 1)],
        candidates: [
          candidate('ok', { med: 1 }),
          candidate('ex', { med: 5 }),
          candidate('away', { med: 5 }, { unavailable: true }),
          candidate('booked', { med: 5 }, { committed: true }),
          candidate('full', { med: 5 }, { load: 9 }),
        ],
      }),
      { solver },
    );
    const text = JSON.stringify(r);
    for (const blocked of ['ex', 'away', 'booked', 'full']) {
      expect(text).not.toContain(`"${blocked}"`);
      expect(text).not.toContain(`${blocked}@lrl.space`);
      expect(text).not.toContain(`Name ${blocked}`);
    }
  });
});

describe('determinism', () => {
  const base = input({
    requirements: [requirement('med', 2, 2), requirement('pil', 3, 1), requirement('nav', 1, 1)],
    candidates: Array.from({ length: 12 }, (_, i) =>
      candidate(
        `c${String(i).padStart(2, '0')}`,
        { med: (i % 5) + 1, pil: ((i * 3) % 5) + 1, nav: (i % 2) + 1 },
        { load: i % 3 },
      ),
    ),
  });

  it('gives byte-identical output for the same input, however the input is ordered', () => {
    const first = JSON.stringify(match(base, { solver }));
    for (let i = 0; i < 5; i++) expect(JSON.stringify(match(base, { solver }))).toBe(first);
    const shuffled = {
      ...base,
      requirements: [...base.requirements].reverse(),
      candidates: [...base.candidates].reverse(),
    };
    expect(JSON.stringify(match(shuffled, { solver }))).toBe(first);
    const rotated = {
      ...base,
      candidates: [...base.candidates.slice(5), ...base.candidates.slice(0, 5)],
    };
    expect(JSON.stringify(match(rotated, { solver }))).toBe(first);
  });
});

describe('the heuristic fallback', () => {
  const base = input({
    requirements: [requirement('med', 3, 2), requirement('pil', 4, 1)],
    candidates: [
      candidate('a', { med: 4, pil: 5 }),
      candidate('b', { med: 3 }),
      candidate('c', { med: 5 }, { load: 2 }),
      candidate('d', { pil: 4 }),
      candidate('e', { med: 3 }, { unavailable: true }),
    ],
  });

  it('answers when the solver times out, with a valid team, and says so', () => {
    const r = match(base, { solver: timingOut });
    expect(r.method).toBe('heuristic');
    expect(r.complete).toBe(true);
    expect(ids(r)).not.toContain('e');
    expect(r.coverage.every((c) => c.met === c.required)).toBe(true);
  });

  it('answers when the solver fails, or times out part-way through the passes', () => {
    expect(match(base, { solver: failing }).method).toBe('heuristic');
    for (const passes of [1, 2, 3])
      expect(match(base, { solver: timingOutAfter(solver, passes) }).method).toBe('heuristic');
  });

  it('is deterministic and reaches the exact answer on this instance', () => {
    const exact = match(base, { solver });
    const heuristic = match(base, { solver: timingOut });
    expect(JSON.stringify(match(base, { solver: timingOut }))).toBe(JSON.stringify(heuristic));
    expect(ids(heuristic)).toEqual(ids(exact));
  });

  it('prunes a redundant member with the local search', () => {
    // Greedy picks the specialist first (covers 2 requirements), then the generalist; the specialist alone suffices.
    const r = match(
      input({
        requirements: [requirement('x', 1, 1), requirement('y', 1, 1), requirement('z', 1, 1)],
        candidates: [
          candidate('big', { x: 1, y: 1 }),
          candidate('all', { x: 1, y: 1, z: 1 }),
          candidate('zed', { z: 1 }, { load: 1 }),
        ],
      }),
      { solver: timingOut },
    );
    expect(ids(r)).toEqual(['all']);
  });

  it('returns the best partial team when nothing can meet the requirements', () => {
    const r = match(
      input({
        requirements: [requirement('med', 5, 2)],
        candidates: [candidate('a', { med: 5 }), candidate('b', { med: 4 })],
      }),
      { solver: timingOut },
    );
    expect(ids(r)).toEqual(['a']);
    expect(r).toMatchObject({ method: 'heuristic', complete: false });
    expect(r.coverage[0]!.gap).toMatchObject({ qualifiedTotal: 1 });
  });
});
