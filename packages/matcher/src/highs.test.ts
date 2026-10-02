import { beforeAll, describe, expect, it } from 'vitest';
import { match } from './engine.js';
import { toLp } from './highs.js';
import { candidate, highs, requirement, timingOut } from './test-support.js';
import type { LinearModel, MatchCandidate, Solver } from './types.js';

let solver: Solver;
beforeAll(async () => {
  solver = await highs();
});

const base: LinearModel = {
  sense: 'min',
  objective: [
    { variable: 'x0', coefficient: 4 },
    { variable: 'x1', coefficient: 9 },
    { variable: 'x2', coefficient: 1 },
  ],
  constraints: [
    {
      name: 'c0',
      terms: [
        { variable: 'x0', coefficient: 1 },
        { variable: 'x1', coefficient: 1 },
      ],
      operator: '>=',
      rhs: 1,
    },
    {
      name: 'c1',
      terms: [
        { variable: 'x1', coefficient: 1 },
        { variable: 'x2', coefficient: 1 },
      ],
      operator: '>=',
      rhs: 1,
    },
  ],
  binary: ['x0', 'x1', 'x2'],
  integer: [],
};

describe('the LP text', () => {
  it('writes the model in LP format', () => {
    expect(toLp(base)).toBe(
      [
        'Minimize',
        ' obj: 4 x0 + 9 x1 + 1 x2',
        'Subject To',
        ' c0: 1 x0 + 1 x1 >= 1',
        ' c1: 1 x1 + 1 x2 >= 1',
        'Bounds',
        ' 0 <= x0 <= 1',
        ' 0 <= x1 <= 1',
        ' 0 <= x2 <= 1',
        'Binary',
        ' x0 x1 x2',
        'End',
      ].join('\n'),
    );
  });

  it('handles negative and merged coefficients, maximising, general integers and empty objectives', () => {
    const lp = toLp({
      sense: 'max',
      objective: [
        { variable: 'x0', coefficient: -2 },
        { variable: 'x0', coefficient: 5 },
        { variable: 'u0', coefficient: -1 },
      ],
      constraints: [
        { name: 'k', terms: [{ variable: 'u0', coefficient: 1 }], operator: '<=', rhs: 3 },
      ],
      binary: ['x0'],
      integer: ['u0'],
    });
    expect(lp).toContain('Maximize\n obj: 3 x0 - 1 u0');
    expect(lp).toContain(' 0 <= u0');
    expect(lp).toContain('General\n u0');
    expect(toLp({ ...base, objective: [] })).toContain(' obj: 0 x0');
  });
});

describe('the adapter', () => {
  it('solves to optimality and returns the objective and the variables', () => {
    const outcome = solver.solve(base, { timeLimitSeconds: 2 });
    expect(outcome).toMatchObject({ status: 'optimal', objective: 5 });
    if (outcome.status === 'optimal') {
      expect(outcome.values.x0).toBeCloseTo(1);
      expect(outcome.values.x1).toBeCloseTo(0);
      expect(outcome.values.x2).toBeCloseTo(1);
    }
  });

  it('maximises', () => {
    const outcome = solver.solve(
      {
        ...base,
        sense: 'max',
        constraints: [{ name: 'cap', terms: base.objective, operator: '<=', rhs: 10 }],
      },
      { timeLimitSeconds: 2 },
    );
    expect(outcome).toMatchObject({ status: 'optimal', objective: 10 });
  });

  it('reports an infeasible model', () => {
    const infeasible: LinearModel = {
      ...base,
      constraints: [
        { name: 'no', terms: [{ variable: 'x0', coefficient: 1 }], operator: '>=', rhs: 2 },
      ],
    };
    expect(solver.solve(infeasible, { timeLimitSeconds: 2 })).toEqual({ status: 'infeasible' });
  });

  it('reports a solver failure as an error, not an exception', () => {
    // An option outside HiGHS's range makes the call throw; the adapter turns that into a status.
    expect(solver.solve(base, { timeLimitSeconds: -1 })).toEqual({ status: 'error' });
  });

  it('solves a model with no variables as trivially optimal', () => {
    expect(
      solver.solve(
        { sense: 'min', objective: [], constraints: [], binary: [], integer: [] },
        { timeLimitSeconds: 2 },
      ),
    ).toEqual({
      status: 'optimal',
      objective: 0,
      values: {},
    });
  });

  it('gives the same answer every time (single-threaded, fixed seed)', () => {
    const first = JSON.stringify(solver.solve(base, { timeLimitSeconds: 2 }));
    for (let i = 0; i < 5; i++)
      expect(JSON.stringify(solver.solve(base, { timeLimitSeconds: 2 }))).toBe(first);
  });

  it('reports a zero time limit as a time-out, which sends the engine to the heuristic', () => {
    const outcome = solver.solve(base, { timeLimitSeconds: 0 });
    expect(['time_limit', 'optimal']).toContain(outcome.status);
    const result = match(
      {
        missionId: 'm',
        requirements: [requirement('med', 1, 1)],
        candidates: [candidate('a', { med: 1 })],
        exclude: [],
        cap: 3,
      },
      { solver, timeLimitSeconds: 0 },
    );
    expect(result.complete).toBe(true);
    expect(result.team.map((t) => t.crewMemberId)).toEqual(['a']);
  });
});

describe('at the scale of an organisation (hundreds of candidates)', () => {
  const people = (n: number): MatchCandidate[] =>
    Array.from({ length: n }, (_, i) =>
      candidate(
        `c${String(i).padStart(4, '0')}`,
        {
          med: (i % 5) + 1,
          pil: ((i * 7) % 5) + 1,
          nav: ((i * 3) % 5) + 1,
          eng: ((i * 11) % 5) + 1,
        },
        { load: i % 4, unavailable: i % 9 === 0, committed: i % 13 === 0 },
      ),
    );
  const requirements = [
    requirement('med', 4, 3),
    requirement('pil', 3, 2),
    requirement('nav', 5, 2),
    requirement('eng', 2, 4),
  ];

  it('solves 500 candidates with four requirements well inside the time limit, optimally', () => {
    const started = performance.now();
    const result = match(
      { missionId: 'm', requirements, candidates: people(500), exclude: [], cap: 4 },
      { solver },
    );
    const elapsed = performance.now() - started;
    expect(result.method).toBe('exact');
    expect(result.complete).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });

  it('is never worse than the heuristic, and never larger than it needs to be', () => {
    const input = { missionId: 'm', requirements, candidates: people(300), exclude: [], cap: 4 };
    const exact = match(input, { solver });
    const heuristic = match(input, { solver: timingOut });
    expect(exact.complete).toBe(true);
    const cost = (r: typeof exact) => r.team.reduce((s, m) => s + (m.upcomingMissions + 1) ** 2, 0);
    expect(cost(exact)).toBeLessThanOrEqual(cost(heuristic));
    expect(exact.team.length).toBeLessThanOrEqual(heuristic.team.length);
    expect(JSON.stringify(match(input, { solver }))).toBe(JSON.stringify(exact));
  });

  it('gives the same team however the 500 candidates are ordered', () => {
    const input = {
      missionId: 'm',
      requirements,
      candidates: people(500),
      exclude: ['c0001', 'c0002'],
      cap: 4,
    };
    const first = JSON.stringify(match(input, { solver }));
    const reversed = { ...input, candidates: [...input.candidates].reverse() };
    expect(JSON.stringify(match(reversed, { solver }))).toBe(first);
  });
});
