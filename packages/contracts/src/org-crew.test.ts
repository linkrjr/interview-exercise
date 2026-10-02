import { describe, expect, it } from 'vitest';
import {
  AddUnavailabilityRequestSchema,
  CreateSkillRequestSchema,
  ListAuditQuerySchema,
  ListCrewQuerySchema,
  ProblemDetailsSchema,
  SetCrewSkillRequestSchema,
  UpdateOrgSettingsRequestSchema,
  isIanaTimeZone,
  parseDateOrTimestamp,
} from './index.js';

const UUID = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000';

describe('time zones', () => {
  it.each([
    'UTC',
    'Europe/London',
    'Asia/Kolkata',
    'America/Argentina/Buenos_Aires',
    'Pacific/Kiritimati',
    'Etc/GMT+5',
  ])('accepts %s', (zone) => expect(isIanaTimeZone(zone)).toBe(true));

  it.each([
    '',
    ' ',
    'Mars/Olympus',
    '+01:00',
    '-05:00',
    'Europe/',
    '/London',
    'UTC; DROP TABLE x',
    'Europe London',
    '../etc/passwd',
  ])('rejects %j', (zone) => expect(isIanaTimeZone(zone)).toBe(false));
});

describe('UpdateOrgSettingsRequestSchema', () => {
  it('needs a change, trims the zone and bounds the cap to 1-20', () => {
    expect(UpdateOrgSettingsRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateOrgSettingsRequestSchema.parse({ timeZone: ' Europe/London ' }).timeZone).toBe(
      'Europe/London',
    );
    for (const cap of [1, 20])
      expect(UpdateOrgSettingsRequestSchema.safeParse({ maxUpcomingMissions: cap }).success).toBe(
        true,
      );
    for (const cap of [0, 21, -1, 1.5, '3', null]) {
      expect(
        UpdateOrgSettingsRequestSchema.safeParse({ maxUpcomingMissions: cap }).success,
        String(cap),
      ).toBe(false);
    }
  });
});

describe('skills', () => {
  it('trims and collapses names, and bounds their length', () => {
    expect(CreateSkillRequestSchema.parse({ name: '  Orbital \t  Piloting ' }).name).toBe(
      'Orbital Piloting',
    );
    expect(CreateSkillRequestSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(CreateSkillRequestSchema.safeParse({ name: 'x'.repeat(100) }).success).toBe(true);
    expect(CreateSkillRequestSchema.safeParse({ name: 'x'.repeat(101) }).success).toBe(false);
  });

  it('accepts levels 1 to 5 only', () => {
    for (const level of [1, 2, 3, 4, 5])
      expect(SetCrewSkillRequestSchema.safeParse({ level }).success).toBe(true);
    for (const level of [0, 6, 2.5, '3', undefined])
      expect(SetCrewSkillRequestSchema.safeParse({ level }).success).toBe(false);
  });
});

describe('AddUnavailabilityRequestSchema', () => {
  it('needs real ISO dates, in order, and a bounded note', () => {
    expect(
      AddUnavailabilityRequestSchema.safeParse({ from: '2026-12-20', to: '2026-12-20' }).success,
    ).toBe(true);
    expect(
      AddUnavailabilityRequestSchema.parse({
        from: '2026-12-20',
        to: '2027-01-03',
        note: '  Leave ',
      }).note,
    ).toBe('Leave');
    for (const body of [
      { from: '2026-12-21', to: '2026-12-20' },
      { from: '2026-02-30', to: '2026-03-01' },
      { from: '2026-13-01', to: '2026-13-02' },
      { from: '20/12/2026', to: '2026-12-22' },
      { from: '2026-12-20' },
      { from: '2026-12-20', to: '2026-12-22', note: 'x'.repeat(501) },
    ]) {
      expect(AddUnavailabilityRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
  });
});

describe('ListCrewQuerySchema', () => {
  it('normalises one or many skill filters to a list', () => {
    expect(ListCrewQuerySchema.parse({}).skill).toEqual([]);
    expect(ListCrewQuerySchema.parse({ skill: `${UUID}:3` }).skill).toEqual([`${UUID}:3`]);
    expect(ListCrewQuerySchema.parse({ skill: [`${UUID}:3`, `${UUID}:5`] }).skill).toHaveLength(2);
  });

  it('validates skill filters and the availability window', () => {
    for (const skill of [
      'x',
      `${UUID}:0`,
      `${UUID}:6`,
      UUID,
      'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz:3',
    ]) {
      expect(ListCrewQuerySchema.safeParse({ skill }).success, skill).toBe(false);
    }
    expect(ListCrewQuerySchema.safeParse({ available: '2026-11-02:2026-11-20' }).success).toBe(
      true,
    );
    expect(ListCrewQuerySchema.safeParse({ available: '2026-11-02:2026-11-02' }).success).toBe(
      true,
    );
    for (const available of [
      '2026-11-02',
      '2026-11-20:2026-11-02',
      '2026-02-30:2026-03-01',
      'a:b',
    ]) {
      expect(ListCrewQuerySchema.safeParse({ available }).success, available).toBe(false);
    }
  });
});

describe('ListAuditQuerySchema', () => {
  it('parses filters, defaulting the page size to 50', () => {
    expect(ListAuditQuerySchema.parse({}).limit).toBe(50);
    const q = ListAuditQuerySchema.parse({
      entity: `mission:${UUID}`,
      actor: 'system',
      since: '2026-09-01',
      until: '2026-10-01T12:30:00Z',
    });
    expect(q).toMatchObject({ entity: `mission:${UUID}`, actor: 'system', since: '2026-09-01' });
    expect(ListAuditQuerySchema.safeParse({ actor: UUID }).success).toBe(true);
  });

  it('rejects malformed filters', () => {
    for (const q of [
      { entity: 'mission' },
      { entity: `mission:nope` },
      { actor: 'bob' },
      { since: 'yesterday' },
      { until: '2026-13-40' },
      { limit: 0 },
      { limit: 101 },
    ]) {
      expect(ListAuditQuerySchema.safeParse(q).success, JSON.stringify(q)).toBe(false);
    }
  });

  it('reads a bare date as the start of that day in UTC, and a timestamp as given', () => {
    expect(parseDateOrTimestamp('2026-09-01').toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(parseDateOrTimestamp('2026-09-01T10:00:00+02:00').toISOString()).toBe(
      '2026-09-01T08:00:00.000Z',
    );
  });
});

describe('ProblemDetailsSchema', () => {
  it('keeps extension members', () => {
    const problem = {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      code: 'X',
      missions: [{ id: 'm' }],
    };
    expect(ProblemDetailsSchema.parse(problem)).toEqual(problem);
  });
});
