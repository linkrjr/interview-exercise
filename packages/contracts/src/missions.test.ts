import { describe, expect, it } from 'vitest';
import {
  CreateMissionRequestSchema,
  ListAssignmentsQuerySchema,
  ListMissionsQuerySchema,
  ListNotificationsQuerySchema,
  MissionActionSchema,
  SetCrewRequestSchema,
  SetRequirementsRequestSchema,
  TransitionRequestSchema,
  UpdateMissionRequestSchema,
} from './index.js';

const UUID = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000';
const UUID2 = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001';
const dates = { startDate: '2027-03-01', endDate: '2027-03-10' };

describe('CreateMissionRequestSchema', () => {
  it('trims, defaults the description and keeps a one-day mission', () => {
    expect(CreateMissionRequestSchema.parse({ name: '  Artemis ', ...dates })).toEqual({
      name: 'Artemis',
      description: '',
      ...dates,
    });
    expect(
      CreateMissionRequestSchema.safeParse({
        name: 'X',
        startDate: '2027-03-01',
        endDate: '2027-03-01',
      }).success,
    ).toBe(true);
  });

  it.each([
    [{ ...dates }],
    [{ name: '  ', ...dates }],
    [{ name: 'x'.repeat(201), ...dates }],
    [{ name: 'X', description: 'y'.repeat(5001), ...dates }],
    [{ name: 'X', startDate: '2027-03-10', endDate: '2027-03-01' }],
    [{ name: 'X', startDate: '2027-02-30', endDate: '2027-03-01' }],
    [{ name: 'X', startDate: '2027-03-01' }],
  ])('rejects %j', (body) => {
    expect(CreateMissionRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('UpdateMissionRequestSchema', () => {
  it('needs something to change and keeps dates ordered when both are given', () => {
    expect(UpdateMissionRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateMissionRequestSchema.safeParse({ name: 'X' }).success).toBe(true);
    expect(UpdateMissionRequestSchema.safeParse({ startDate: '2027-04-01' }).success).toBe(true);
    expect(
      UpdateMissionRequestSchema.safeParse({ startDate: '2027-04-01', endDate: '2027-03-01' })
        .success,
    ).toBe(false);
    expect(UpdateMissionRequestSchema.safeParse({ name: '' }).success).toBe(false);
  });
});

describe('SetRequirementsRequestSchema', () => {
  const r = (over: object = {}) => ({ skillId: UUID, minLevel: 3, count: 1, ...over });

  it('accepts a set, an empty set, and levels 1 to 5', () => {
    expect(SetRequirementsRequestSchema.safeParse({ requirements: [] }).success).toBe(true);
    for (const minLevel of [1, 5])
      expect(
        SetRequirementsRequestSchema.safeParse({ requirements: [r({ minLevel })] }).success,
      ).toBe(true);
    expect(
      SetRequirementsRequestSchema.safeParse({ requirements: [r(), r({ skillId: UUID2 })] })
        .success,
    ).toBe(true);
  });

  it.each([
    [[r({ minLevel: 0 })]],
    [[r({ minLevel: 6 })]],
    [[r({ count: 0 })]],
    [[r({ count: 1001 })]],
    [[r({ count: 1.5 })]],
    [[r({ skillId: 'nope' })]],
    [[r(), r({ minLevel: 4 })]], // one requirement per skill
    [
      Array.from({ length: 51 }, (_, i) =>
        r({ skillId: `0199aaaa-bbbb-7ccc-8ddd-${String(i).padStart(12, '0')}` }),
      ),
    ],
  ])('rejects %j', (requirements) => {
    expect(SetRequirementsRequestSchema.safeParse({ requirements }).success).toBe(false);
  });
});

describe('SetCrewRequestSchema', () => {
  it('accepts a list of distinct ids, including none', () => {
    expect(SetCrewRequestSchema.safeParse({ crewMemberIds: [] }).success).toBe(true);
    expect(SetCrewRequestSchema.safeParse({ crewMemberIds: [UUID, UUID2] }).success).toBe(true);
  });

  it('rejects repeats, non-ids and too many', () => {
    expect(SetCrewRequestSchema.safeParse({ crewMemberIds: [UUID, UUID] }).success).toBe(false);
    expect(SetCrewRequestSchema.safeParse({ crewMemberIds: ['x'] }).success).toBe(false);
    expect(SetCrewRequestSchema.safeParse({}).success).toBe(false);
    expect(
      SetCrewRequestSchema.safeParse({
        crewMemberIds: Array.from(
          { length: 201 },
          (_, i) => `0199aaaa-bbbb-7ccc-8ddd-${String(i).padStart(12, '0')}`,
        ),
      }).success,
    ).toBe(false);
  });
});

describe('TransitionRequestSchema', () => {
  it('accepts exactly the seven user actions, never the system ones', () => {
    expect(MissionActionSchema.options).toEqual([
      'start_crewing',
      'reopen',
      'submit',
      'withdraw',
      'approve',
      'reject',
      'cancel',
    ]);
    for (const action of MissionActionSchema.options)
      expect(TransitionRequestSchema.safeParse({ action }).success).toBe(true);
    for (const action of ['activate', 'complete', 'expire', 'teleport', ''])
      expect(TransitionRequestSchema.safeParse({ action }).success).toBe(false);
  });

  it('trims the comment and bounds its length', () => {
    expect(
      TransitionRequestSchema.parse({ action: 'reject', comment: ' Too risky ' }).comment,
    ).toBe('Too risky');
    expect(
      TransitionRequestSchema.safeParse({ action: 'reject', comment: 'x'.repeat(1001) }).success,
    ).toBe(false);
  });
});

describe('list queries', () => {
  it('normalises one or many statuses to a list and bounds the page', () => {
    expect(ListMissionsQuerySchema.parse({}).status).toEqual([]);
    expect(ListMissionsQuerySchema.parse({}).limit).toBe(25);
    expect(ListMissionsQuerySchema.parse({ status: 'draft' }).status).toEqual(['draft']);
    expect(
      ListMissionsQuerySchema.parse({ status: ['draft', 'crewing'], limit: '100' }),
    ).toMatchObject({ status: ['draft', 'crewing'], limit: 100 });
    for (const q of [
      { status: 'nope' },
      { limit: 0 },
      { limit: 101 },
      { leadId: 'x' },
      { from: '2027-02-30' },
      { from: '2027-03-02', to: '2027-03-01' },
    ]) {
      expect(ListMissionsQuerySchema.safeParse(q).success, JSON.stringify(q)).toBe(false);
    }
    expect(
      ListMissionsQuerySchema.safeParse({ from: '2027-03-01', to: '2027-03-01' }).success,
    ).toBe(true);
  });

  it('parses the unread flag and page sizes of notifications and assignments', () => {
    expect(ListNotificationsQuerySchema.parse({ unread: 'true' }).unread).toBe(true);
    expect(ListNotificationsQuerySchema.parse({ unread: 'false' }).unread).toBe(false);
    expect(ListNotificationsQuerySchema.parse({}).unread).toBeUndefined();
    expect(ListNotificationsQuerySchema.safeParse({ unread: 'maybe' }).success).toBe(false);
    expect(ListAssignmentsQuerySchema.parse({}).limit).toBe(25);
    expect(ListAssignmentsQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });
});
