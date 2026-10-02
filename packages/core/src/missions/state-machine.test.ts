import {
  MissionActionSchema,
  MissionStatusSchema,
  type MissionAction,
  type MissionStatus,
} from '@mc/contracts';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CREW_VISIBLE_STATUSES,
  EDITABLE_STATUSES,
  HELD_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  actionsFor,
  transitionFor,
} from './state-machine.js';

const STATUSES = MissionStatusSchema.options;
const USER_ACTIONS = MissionActionSchema.options;

describe('transition table (DESIGN.md §7.2)', () => {
  it('contains exactly the documented transitions', () => {
    expect(TRANSITIONS.map((t) => [t.action, [...t.from], t.to, t.by])).toEqual([
      ['start_crewing', ['draft'], 'crewing', 'owner'],
      ['reopen', ['crewing'], 'draft', 'owner'],
      ['submit', ['crewing'], 'pending_approval', 'owner'],
      ['withdraw', ['pending_approval'], 'crewing', 'owner'],
      ['approve', ['pending_approval'], 'approved', 'director'],
      ['reject', ['pending_approval'], 'crewing', 'director'],
      ['cancel', ['draft', 'crewing', 'pending_approval', 'approved'], 'cancelled', 'owner'],
      ['activate', ['approved'], 'active', 'system'],
      ['complete', ['active'], 'completed', 'system'],
      ['expire', ['pending_approval'], 'crewing', 'system'],
    ]);
  });

  it('has one definition per action, and every user action is in it', () => {
    expect(new Set(TRANSITIONS.map((t) => t.action)).size).toBe(TRANSITIONS.length);
    for (const action of USER_ACTIONS) expect(transitionFor(action).by).not.toBe('system');
    expect(() => transitionFor('teleport' as never)).toThrow(/Unknown mission transition/);
  });

  it('never leaves a terminal state, and reaches every state from Draft', () => {
    for (const t of TRANSITIONS) {
      for (const from of t.from) expect(TERMINAL_STATUSES).not.toContain(from);
    }
    const reached = new Set<MissionStatus>(['draft']);
    for (let i = 0; i < STATUSES.length; i++) {
      for (const t of TRANSITIONS) if (t.from.some((s) => reached.has(s))) reached.add(t.to);
    }
    expect([...reached].sort()).toEqual([...STATUSES].sort());
  });

  it('keeps Directors off cancel and off any action of the owning Lead', () => {
    for (const status of STATUSES) {
      const director = actionsFor('director', status);
      expect(director).not.toContain('cancel');
      expect(director.every((a) => ['approve', 'reject'].includes(a))).toBe(true);
    }
  });

  it('lets only the system activate, complete and expire', () => {
    for (const status of STATUSES) {
      for (const by of ['owner', 'director'] as const) {
        expect(actionsFor(by, status)).not.toEqual(expect.arrayContaining(['activate']));
        for (const a of actionsFor(by, status))
          expect(['activate', 'complete', 'expire']).not.toContain(a);
      }
    }
  });
});

describe('actionsFor, every (status, action, actor) combination', () => {
  const cases = STATUSES.flatMap((status) =>
    USER_ACTIONS.flatMap((action) =>
      (['owner', 'director'] as const).map((by) => {
        const t = transitionFor(action);
        return { status, action, by, allowed: t.by === by && t.from.includes(status) };
      }),
    ),
  );

  it.each(cases)(
    '$by may $action a $status mission: $allowed',
    ({ status, action, by, allowed }) => {
      expect(actionsFor(by, status).includes(action as MissionAction)).toBe(allowed);
    },
  );

  it('lists the documented actions per status for the owning Lead', () => {
    expect(actionsFor('owner', 'draft')).toEqual(['start_crewing', 'cancel']);
    expect(actionsFor('owner', 'crewing')).toEqual(['reopen', 'submit', 'cancel']);
    expect(actionsFor('owner', 'pending_approval')).toEqual(['withdraw', 'cancel']);
    expect(actionsFor('owner', 'approved')).toEqual(['cancel']);
    for (const status of ['active', 'completed', 'cancelled'] as const)
      expect(actionsFor('owner', status)).toEqual([]);
  });

  it('lists approve and reject for Directors only while Pending approval', () => {
    expect(actionsFor('director', 'pending_approval')).toEqual(['approve', 'reject']);
    for (const status of STATUSES.filter((s) => s !== 'pending_approval'))
      expect(actionsFor('director', status)).toEqual([]);
  });
});

describe('status groups', () => {
  it('match the documented rules', () => {
    expect(EDITABLE_STATUSES).toEqual(['draft', 'crewing']);
    expect(HELD_STATUSES).toEqual(['pending_approval', 'approved', 'active']);
    expect(CREW_VISIBLE_STATUSES).toEqual(['approved', 'active', 'completed']);
    expect(TERMINAL_STATUSES).toEqual(['completed', 'cancelled']);
  });
});

describe('the single writer of missions.status (DESIGN.md §21)', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? sources(join(dir, e.name))
        : /\.ts$/.test(e.name) && !/\.(test|integration\.test)\.ts$/.test(e.name)
          ? [join(dir, e.name)]
          : [],
    );

  it('is transitions.ts: no other module sets a mission status', () => {
    const offenders: string[] = [];
    for (const file of sources(root)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/update\(schema\.missions\)\s*\.set\(\{([\s\S]*?)\}\)/g)) {
        if (/\bstatus\b/.test(match[1]!) && !file.endsWith('missions/transitions.ts'))
          offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
    expect(readFileSync(join(root, 'missions/transitions.ts'), 'utf8')).toMatch(
      /update\(schema\.missions\)[\s\S]*status: def\.to/,
    );
  });
});
