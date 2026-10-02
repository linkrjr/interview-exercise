import { createHarness, missionWorld, type Harness, type MissionWorld } from '@mc/core/testing';
import { newId } from '@mc/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from './app.js';

const urls = inject('dbUrls');
const OPERATOR = 'operator-token-for-tests-0123456789abcdef';

let h: Harness;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  h = await createHarness(urls, { dbAudit: true });
  app = buildApp({
    services: h,
    accessTokens: h.accessTokens,
    operatorToken: OPERATOR,
    loginRate: { emailMax: 50, ipMax: 500, windowMs: 60_000 },
    clock: h.clock,
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await h.close();
});

// Response bodies are inspected loosely, field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type Person = { userId: string; actor: { orgId: string; role: string } };

const tokenFor = (who: Person) =>
  h.accessTokens.sign({ userId: who.userId, orgId: who.actor.orgId, role: who.actor.role });

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  options: {
    as?: Person;
    body?: unknown;
    version?: number | string;
    headers?: Record<string, string>;
  } = {},
) {
  const res = await app.inject({
    method,
    url,
    headers: {
      ...(options.as ? { authorization: `Bearer ${await tokenFor(options.as)}` } : {}),
      ...(options.version !== undefined ? { 'if-match': String(options.version) } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });
  let body: Json | undefined;
  try {
    body = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.statusCode, headers: res.headers, body: body as Json };
}

const dates = { startDate: '2027-03-01', endDate: '2027-03-10' };
const req = (w: MissionWorld, level = 3, count = 1) => ({
  requirements: [{ skillId: w.medicine.id, minLevel: level, count }],
});

async function mission(w: MissionWorld, name = 'Artemis Relay') {
  const res = await call('POST', '/v1/missions', {
    as: w.lead,
    body: { name, description: 'd', ...dates },
  });
  expect(res.status).toBe(201);
  return res.body;
}

describe('authentication', () => {
  it('requires a signed-in user on every mission, assignment and notification endpoint', async () => {
    const endpoints: Array<['GET' | 'POST' | 'PATCH' | 'PUT', string]> = [
      ['GET', '/v1/missions'],
      ['POST', '/v1/missions'],
      ['GET', `/v1/missions/${newId()}`],
      ['PATCH', `/v1/missions/${newId()}`],
      ['PUT', `/v1/missions/${newId()}/requirements`],
      ['PUT', `/v1/missions/${newId()}/crew`],
      ['POST', `/v1/missions/${newId()}/transitions`],
      ['GET', '/v1/assignments/me'],
      ['POST', `/v1/assignments/${newId()}/acknowledge`],
      ['GET', '/v1/notifications'],
      ['POST', `/v1/notifications/${newId()}/read`],
    ];
    for (const [method, url] of endpoints) {
      const res = await call(method, url, { body: {}, version: 1 });
      expect(res.status, `${method} ${url}`).toBe(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
    }
  });
});

describe('creating and reading', () => {
  it('creates (201) with an ETag carrying the version, and reads it back', async () => {
    const w = await missionWorld(h, 'HTTP create');
    const res = await call('POST', '/v1/missions', {
      as: w.lead,
      body: { name: '  Artemis  ', ...dates },
    });
    expect(res.status).toBe(201);
    expect(res.headers.etag).toBe('"1"');
    expect(res.body).toMatchObject({
      name: 'Artemis',
      description: '',
      status: 'draft',
      version: 1,
      leadId: w.lead.userId,
      allowedActions: ['start_crewing', 'cancel'],
    });
    const got = await call('GET', `/v1/missions/${res.body.id}`, { as: w.director });
    expect(got.status).toBe(200);
    expect(got.headers.etag).toBe('"1"');
    expect(got.body.id).toBe(res.body.id);
  });

  it('validates the body with field errors', async () => {
    const w = await missionWorld(h, 'HTTP create invalid');
    const bad: Array<[Json, string]> = [
      [{ ...dates }, 'name'],
      [{ name: '', ...dates }, 'name'],
      [{ name: 'x'.repeat(201), ...dates }, 'name'],
      [{ name: 'X', startDate: '2027-03-10', endDate: '2027-03-01' }, 'endDate'],
      [{ name: 'X', startDate: '2027-02-30', endDate: '2027-03-01' }, 'startDate'],
      [{ name: 'X', startDate: '03/01/2027', endDate: '2027-03-02' }, 'startDate'],
      [{ name: 'X', startDate: '2027-03-01' }, 'endDate'],
      [{ name: 'X', description: 'y'.repeat(5001), ...dates }, 'description'],
    ];
    for (const [body, field] of bad) {
      const res = await call('POST', '/v1/missions', { as: w.lead, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.errors.map((e: Json) => e.field)).toContain(field);
    }
  });

  it('is for Leads only, and Crew and Directors get 403', async () => {
    const w = await missionWorld(h, 'HTTP create roles');
    for (const who of [w.director, w.ann]) {
      const res = await call('POST', '/v1/missions', { as: who, body: { name: 'X', ...dates } });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
  });

  it('lists with repeated status filters, a lead filter and date windows, and pages', async () => {
    const w = await missionWorld(h, 'HTTP list');
    const a = await mission(w, 'A');
    const b = await call('POST', '/v1/missions', {
      as: w.lead2,
      body: { name: 'B', startDate: '2027-08-01', endDate: '2027-08-05' },
    });
    await call('POST', `/v1/missions/${a.id}/transitions`, {
      as: w.lead,
      body: { action: 'cancel' },
      version: 1,
    });
    const names = async (query: string, who = w.director) =>
      ((await call('GET', `/v1/missions${query}`, { as: who })).body.items as Json[]).map(
        (m) => m.name,
      );
    expect(await names('')).toEqual(['B', 'A']);
    expect(await names('?status=cancelled')).toEqual(['A']);
    expect(await names('?status=cancelled&status=draft')).toEqual(['B', 'A']);
    expect(await names(`?leadId=${w.lead2.userId}`)).toEqual(['B']);
    expect(await names('?from=2027-07-01&to=2027-09-01')).toEqual(['B']);
    const page = await call('GET', '/v1/missions?limit=1', { as: w.lead });
    expect(page.body.items).toHaveLength(1);
    expect(page.body.nextCursor).toEqual(expect.any(String));
    expect(
      (await call('GET', `/v1/missions?limit=1&cursor=${page.body.nextCursor}`, { as: w.lead }))
        .body.items[0].name,
    ).toBe('A');
    void b;
    for (const q of [
      '?status=nope',
      '?limit=0',
      '?limit=101',
      '?from=2027-09-01&to=2027-08-01',
      '?leadId=nope',
      '?cursor=garbage',
    ]) {
      expect((await call('GET', `/v1/missions${q}`, { as: w.lead })).status, q).toBe(400);
    }
  });

  it("answers 404 for unknown, malformed and another organisation's ids, on every id endpoint", async () => {
    const w = await missionWorld(h, 'HTTP 404');
    const other = await missionWorld(h, 'HTTP 404 other');
    const theirs = await call('POST', '/v1/missions', {
      as: other.lead,
      body: { name: 'T', ...dates },
    });
    const calls = [
      call('GET', `/v1/missions/${theirs.body.id}`, { as: w.director }),
      call('PATCH', `/v1/missions/${theirs.body.id}`, {
        as: w.lead,
        body: { name: 'X' },
        version: 1,
      }),
      call('PUT', `/v1/missions/${theirs.body.id}/requirements`, {
        as: w.lead,
        body: { requirements: [] },
        version: 1,
      }),
      call('PUT', `/v1/missions/${theirs.body.id}/crew`, {
        as: w.lead,
        body: { crewMemberIds: [] },
        version: 1,
      }),
      call('POST', `/v1/missions/${theirs.body.id}/transitions`, {
        as: w.lead,
        body: { action: 'cancel' },
        version: 1,
      }),
      call('GET', `/v1/missions/${newId()}`, { as: w.director }),
      call('GET', '/v1/missions/not-a-uuid', { as: w.director }),
      call('PATCH', '/v1/missions/not-a-uuid', { as: w.lead, body: { name: 'X' }, version: 1 }),
      call('POST', '/v1/missions/not-a-uuid/transitions', {
        as: w.lead,
        body: { action: 'cancel' },
        version: 1,
      }),
      call('POST', '/v1/assignments/not-a-uuid/acknowledge', { as: w.ann }),
      call('POST', `/v1/notifications/${newId()}/read`, { as: w.ann }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    expect(
      (await call('GET', `/v1/missions/${theirs.body.id}`, { as: other.lead })).body.status,
    ).toBe('draft');
  });
});

describe('If-Match and ETag (DESIGN.md §13)', () => {
  it('requires If-Match on every change: 428 when it is missing', async () => {
    const w = await missionWorld(h, 'HTTP ifmatch');
    const m = await mission(w);
    const changes: Array<['PATCH' | 'PUT' | 'POST', string, Json]> = [
      ['PATCH', `/v1/missions/${m.id}`, { name: 'X' }],
      ['PUT', `/v1/missions/${m.id}/requirements`, req(w)],
      ['PUT', `/v1/missions/${m.id}/crew`, { crewMemberIds: [] }],
      ['POST', `/v1/missions/${m.id}/transitions`, { action: 'cancel' }],
    ];
    for (const [method, url, body] of changes) {
      const res = await call(method, url, { as: w.lead, body });
      expect(res.status, `${method} ${url}`).toBe(428);
      expect(res.body.code).toBe('IF_MATCH_REQUIRED');
    }
    expect((await call('GET', `/v1/missions/${m.id}`, { as: w.lead })).body.version).toBe(1);
  });

  it('accepts the version bare, quoted or weak, and rejects anything else with 400', async () => {
    const w = await missionWorld(h, 'HTTP ifmatch forms');
    let m = await mission(w);
    for (const [format, next] of [
      [(v: number) => `${v}`, 2],
      [(v: number) => `"${v}"`, 3],
      [(v: number) => `W/"${v}"`, 4],
    ] as const) {
      const res = await call('PATCH', `/v1/missions/${m.id}`, {
        as: w.lead,
        body: { description: `v${next}` },
        version: format(m.version),
      });
      expect(res.status).toBe(200);
      expect(res.body.version).toBe(next);
      expect(res.headers.etag).toBe(`"${next}"`);
      m = res.body;
    }
    for (const bad of ['abc', '"x"', '1.5', '-1', '']) {
      const res = await call('PATCH', `/v1/missions/${m.id}`, {
        as: w.lead,
        body: { name: 'X' },
        version: bad,
      });
      expect(res.status, bad).toBe(400);
      expect(res.body.errors[0].field).toBe('If-Match');
    }
  });

  it('answers a stale version with 412 and the current version, and changes nothing', async () => {
    const w = await missionWorld(h, 'HTTP stale');
    const m = await mission(w);
    const ok = await call('PATCH', `/v1/missions/${m.id}`, {
      as: w.lead,
      body: { name: 'First' },
      version: 1,
    });
    expect(ok.body.version).toBe(2);
    const stale = await call('PATCH', `/v1/missions/${m.id}`, {
      as: w.lead,
      body: { name: 'Second' },
      version: 1,
    });
    expect(stale.status).toBe(412);
    expect(stale.headers['content-type']).toContain('application/problem+json');
    expect(stale.body).toMatchObject({
      code: 'MISSION_VERSION_MISMATCH',
      status: 412,
      currentVersion: 2,
    });
    expect((await call('GET', `/v1/missions/${m.id}`, { as: w.lead })).body.name).toBe('First');
  });

  it('sends the ETag with every staff response and none to Crew', async () => {
    const w = await missionWorld(h, 'HTTP etag');
    const approved = await w.approved();
    const staff = await call('GET', `/v1/missions/${approved.id}`, { as: w.lead });
    expect(staff.headers.etag).toBe(`"${approved.version}"`);
    const crew = await call('GET', `/v1/missions/${approved.id}`, { as: w.ann });
    expect(crew.status).toBe(200);
    expect(crew.headers.etag).toBeUndefined();
    expect(crew.body).not.toHaveProperty('version');
  });
});

describe('the lifecycle over HTTP', () => {
  it('runs create → requirements → crewing → crew → submit → approve → acknowledge, with notifications', async () => {
    const w = await missionWorld(h, 'HTTP flow');
    let m = await mission(w);
    const step = async (res: Awaited<ReturnType<typeof call>>) => {
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      return res.body;
    };
    m = await step(
      await call('PUT', `/v1/missions/${m.id}/requirements`, {
        as: w.lead,
        body: req(w),
        version: m.version,
      }),
    );
    expect(m.requirements).toEqual([
      { skillId: w.medicine.id, skillName: 'Medicine', minLevel: 3, count: 1 },
    ]);
    m = await step(
      await call('POST', `/v1/missions/${m.id}/transitions`, {
        as: w.lead,
        body: { action: 'start_crewing' },
        version: m.version,
      }),
    );
    expect(m.status).toBe('crewing');
    expect(m.crewValidation).toMatchObject({
      valid: false,
      unmetRequirements: [{ required: 1, met: 0 }],
    });
    m = await step(
      await call('PUT', `/v1/missions/${m.id}/crew`, {
        as: w.lead,
        body: { crewMemberIds: [w.ann.userId] },
        version: m.version,
      }),
    );
    expect(m.crewValidation).toEqual({ valid: true, assignmentIssues: [], unmetRequirements: [] });
    m = await step(
      await call('POST', `/v1/missions/${m.id}/transitions`, {
        as: w.lead,
        body: { action: 'submit' },
        version: m.version,
      }),
    );
    expect(m.status).toBe('pending_approval');

    const queue = await call('GET', '/v1/missions?status=pending_approval', { as: w.director });
    expect(queue.body.items.map((i: Json) => i.id)).toEqual([m.id]);
    const inbox = await call('GET', '/v1/notifications?unread=true', { as: w.director });
    expect(inbox.body.items[0]).toMatchObject({
      type: 'mission.submitted',
      readAt: null,
      payload: { missionId: m.id },
    });
    const read = await call('POST', `/v1/notifications/${inbox.body.items[0].id}/read`, {
      as: w.director,
    });
    expect(read.body.readAt).toEqual(expect.any(String));
    expect(
      (await call('GET', '/v1/notifications?unread=true', { as: w.director })).body.items,
    ).toEqual([]);

    m = await step(
      await call('POST', `/v1/missions/${m.id}/transitions`, {
        as: w.director,
        body: { action: 'approve', comment: 'Go' },
        version: m.version,
      }),
    );
    expect(m).toMatchObject({
      status: 'approved',
      allowedActions: [],
      decisions: [expect.objectContaining({ decision: 'approved', comment: 'Go' })],
    });

    const mine = await call('GET', '/v1/assignments/me', { as: w.ann });
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({
      acknowledgedAt: null,
      mission: { id: m.id, status: 'approved' },
    });
    const ack = await call('POST', `/v1/assignments/${mine.body.items[0].id}/acknowledge`, {
      as: w.ann,
    });
    expect(ack.status).toBe(200);
    expect(ack.body.acknowledgedAt).toEqual(expect.any(String));
    const seen = await call('GET', `/v1/missions/${m.id}`, { as: w.lead });
    expect(seen.body.crew[0].acknowledgedAt).toBe(ack.body.acknowledgedAt);
    expect(
      (await call('GET', '/v1/notifications', { as: w.ann })).body.items.map((n: Json) => n.type),
    ).toEqual(['mission.assigned']);
    expect(
      (await call('GET', '/v1/notifications', { as: w.lead })).body.items.map((n: Json) => n.type),
    ).toEqual(['mission.approved']);
  });

  it('maps who and when to 403 and 409, with the allowed actions', async () => {
    const w = await missionWorld(h, 'HTTP denials');
    const m = await mission(w);
    const forbidden = [
      await call('POST', `/v1/missions/${m.id}/transitions`, {
        as: w.lead2,
        body: { action: 'cancel' },
        version: m.version,
      }),
      await call('POST', `/v1/missions/${m.id}/transitions`, {
        as: w.director,
        body: { action: 'cancel' },
        version: m.version,
      }),
      await call('POST', `/v1/missions/${m.id}/transitions`, {
        as: w.ann,
        body: { action: 'start_crewing' },
        version: m.version,
      }),
      await call('POST', `/v1/missions/${m.id}/transitions`, {
        as: w.lead,
        body: { action: 'approve' },
        version: m.version,
      }),
      await call('PATCH', `/v1/missions/${m.id}`, {
        as: w.lead2,
        body: { name: 'X' },
        version: m.version,
      }),
      await call('PUT', `/v1/missions/${m.id}/crew`, {
        as: w.director,
        body: { crewMemberIds: [] },
        version: m.version,
      }),
    ];
    for (const res of forbidden)
      expect(res).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });

    const invalid = await call('POST', `/v1/missions/${m.id}/transitions`, {
      as: w.lead,
      body: { action: 'submit' },
      version: m.version,
    });
    expect(invalid.status).toBe(409);
    // `status` stays the HTTP status of the problem; the mission's own status is `missionStatus`.
    expect(invalid.body).toMatchObject({
      status: 409,
      code: 'MISSION_INVALID_TRANSITION',
      missionStatus: 'draft',
      allowedActions: ['start_crewing', 'cancel'],
    });
  });

  it('reports why a submit failed, with the failure kinds and the people', async () => {
    const w = await missionWorld(h, 'HTTP submit');
    await w.approved({ startDate: '2027-03-05', endDate: '2027-03-06' });
    let m = await w.crewing({
      crew: [w.ann.userId],
      startDate: '2027-03-01',
      endDate: '2027-03-10',
    });
    const clash = await call('POST', `/v1/missions/${m.id}/transitions`, {
      as: w.lead,
      body: { action: 'submit' },
      version: m.version,
    });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({
      code: 'CREW_DOUBLE_BOOKED',
      issues: [{ code: 'CREW_DOUBLE_BOOKED', crewMemberIds: [w.ann.userId] }],
    });

    m = await h.missions.replaceCrew(w.lead.actor, m.id, [], { version: m.version });
    const empty = await call('POST', `/v1/missions/${m.id}/transitions`, {
      as: w.lead,
      body: { action: 'submit' },
      version: m.version,
    });
    expect(empty.body.code).toBe('MISSION_CREW_EMPTY');

    m = await h.missions.replaceCrew(w.lead.actor, m.id, [w.bob.userId], { version: m.version });
    m = await h.missions.setRequirements(
      w.lead.actor,
      m.id,
      { requirements: [{ skillId: w.medicine.id, minLevel: 4, count: 1 }] },
      m.version,
    );
    const unmet = await call('POST', `/v1/missions/${m.id}/transitions`, {
      as: w.lead,
      body: { action: 'submit' },
      version: m.version,
    });
    expect(unmet.body).toMatchObject({
      code: 'REQUIREMENTS_NOT_MET',
      unmetRequirements: [{ skillId: w.medicine.id, minLevel: 4, required: 1, met: 0 }],
    });
  });

  it('requires a reason to reject, as a field error', async () => {
    const w = await missionWorld(h, 'HTTP reject');
    const p = await w.pending();
    for (const comment of [undefined, '', '   ']) {
      const res = await call('POST', `/v1/missions/${p.id}/transitions`, {
        as: w.director,
        body: { action: 'reject', ...(comment !== undefined ? { comment } : {}) },
        version: p.version,
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'REJECTION_REASON_REQUIRED',
        errors: [expect.objectContaining({ field: 'comment' })],
      });
    }
    const ok = await call('POST', `/v1/missions/${p.id}/transitions`, {
      as: w.director,
      body: { action: 'reject', comment: ' Too risky ' },
      version: p.version,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.decisions[0]).toMatchObject({ decision: 'rejected', comment: 'Too risky' });
    expect((await call('GET', '/v1/notifications', { as: w.lead })).body.items[0]).toMatchObject({
      type: 'mission.rejected',
      payload: { reason: 'Too risky' },
    });
  });

  it('validates the transition, requirement and crew bodies', async () => {
    const w = await missionWorld(h, 'HTTP bodies');
    const m = await mission(w);
    const bad: Array<['PATCH' | 'PUT' | 'POST', string, Json, string]> = [
      ['POST', `/v1/missions/${m.id}/transitions`, { action: 'teleport' }, 'action'],
      ['POST', `/v1/missions/${m.id}/transitions`, { action: 'activate' }, 'action'],
      ['POST', `/v1/missions/${m.id}/transitions`, {}, 'action'],
      [
        'PUT',
        `/v1/missions/${m.id}/requirements`,
        { requirements: [{ skillId: w.medicine.id, minLevel: 0, count: 1 }] },
        'requirements.0.minLevel',
      ],
      [
        'PUT',
        `/v1/missions/${m.id}/requirements`,
        { requirements: [{ skillId: w.medicine.id, minLevel: 6, count: 1 }] },
        'requirements.0.minLevel',
      ],
      [
        'PUT',
        `/v1/missions/${m.id}/requirements`,
        { requirements: [{ skillId: w.medicine.id, minLevel: 3, count: 0 }] },
        'requirements.0.count',
      ],
      [
        'PUT',
        `/v1/missions/${m.id}/requirements`,
        { requirements: [{ skillId: 'nope', minLevel: 3, count: 1 }] },
        'requirements.0.skillId',
      ],
      [
        'PUT',
        `/v1/missions/${m.id}/requirements`,
        {
          requirements: [
            { skillId: w.medicine.id, minLevel: 3, count: 1 },
            { skillId: w.medicine.id, minLevel: 4, count: 2 },
          ],
        },
        'requirements',
      ],
      ['PUT', `/v1/missions/${m.id}/crew`, { crewMemberIds: ['nope'] }, 'crewMemberIds.0'],
      [
        'PUT',
        `/v1/missions/${m.id}/crew`,
        { crewMemberIds: [w.ann.userId, w.ann.userId] },
        'crewMemberIds',
      ],
      ['PUT', `/v1/missions/${m.id}/crew`, {}, 'crewMemberIds'],
      ['PATCH', `/v1/missions/${m.id}`, {}, ''],
      [
        'PATCH',
        `/v1/missions/${m.id}`,
        { startDate: '2027-04-01', endDate: '2027-03-01' },
        'endDate',
      ],
    ];
    for (const [method, url, body, field] of bad) {
      const res = await call(method, url, { as: w.lead, body, version: m.version });
      expect(res.status, `${method} ${url} ${JSON.stringify(body)}`).toBe(400);
      if (field) expect(res.body.errors.map((e: Json) => e.field)).toContain(field);
    }
  });

  it('names the crew members it refuses to assign', async () => {
    const w = await missionWorld(h, 'HTTP assign');
    const m = await w.crewing();
    const res = await call('PUT', `/v1/missions/${m.id}/crew`, {
      as: w.lead,
      body: { crewMemberIds: [w.ann.userId, w.lead2.userId] },
      version: m.version,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'CREW_MEMBER_NOT_ASSIGNABLE',
      crewMemberIds: [w.lead2.userId],
    });
  });

  it('reports locked missions as 409 with their status', async () => {
    const w = await missionWorld(h, 'HTTP locked');
    const p = await w.pending();
    const res = await call('PATCH', `/v1/missions/${p.id}`, {
      as: w.lead,
      body: { name: 'X' },
      version: p.version,
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      status: 409,
      code: 'MISSION_NOT_EDITABLE',
      missionStatus: 'pending_approval',
    });
  });
});

describe('what Crew Members get over HTTP', () => {
  it('lists and shows only their own, in the reduced shape, and 404 otherwise', async () => {
    const w = await missionWorld(h, 'HTTP crew');
    await w.pending({ name: 'Hidden until approved' });
    const approved = await w.approved({
      name: 'Visible',
      startDate: '2027-04-01',
      endDate: '2027-04-05',
    });
    const list = await call('GET', '/v1/missions', { as: w.ann });
    expect(list.body.items.map((i: Json) => i.name)).toEqual(['Visible']);
    expect(list.body.items[0]).toEqual({
      id: approved.id,
      name: 'Visible',
      description: '',
      startDate: '2027-04-01',
      endDate: '2027-04-05',
      status: 'approved',
      assignment: { id: expect.any(String), acknowledgedAt: null },
    });
    expect((await call('GET', `/v1/missions/${approved.id}`, { as: w.bob })).status).toBe(404);
    expect((await call('GET', '/v1/missions', { as: w.bob })).body.items).toEqual([]);
    // Crew cannot change or transition anything, and learn nothing about it.
    const res = await call('POST', `/v1/missions/${approved.id}/transitions`, {
      as: w.bob,
      body: { action: 'cancel' },
      version: approved.version,
    });
    expect(res.status).toBe(403);
  });

  it('does not let Directors or Leads use the Crew assignment endpoints', async () => {
    const w = await missionWorld(h, 'HTTP assignments roles');
    await w.approved();
    for (const who of [w.director, w.lead]) {
      expect((await call('GET', '/v1/assignments/me', { as: who })).status).toBe(403);
    }
    expect((await call('GET', '/v1/assignments/me?limit=0', { as: w.ann })).status).toBe(400);
  });
});

describe('notifications over HTTP', () => {
  it('lists, filters unread, pages and keeps each inbox private', async () => {
    const w = await missionWorld(h, 'HTTP inbox');
    for (let i = 0; i < 3; i++)
      await w.pending({ startDate: `2027-0${i + 3}-01`, endDate: `2027-0${i + 3}-05` });
    const all = await call('GET', '/v1/notifications', { as: w.director });
    expect(all.body.items).toHaveLength(3);
    const page = await call('GET', '/v1/notifications?limit=2', { as: w.director });
    expect(page.body.items).toHaveLength(2);
    expect(
      (
        await call('GET', `/v1/notifications?limit=2&cursor=${page.body.nextCursor}`, {
          as: w.director,
        })
      ).body.items,
    ).toHaveLength(1);
    expect((await call('GET', '/v1/notifications', { as: w.lead })).body.items).toEqual([]);
    const id = all.body.items[0].id;
    expect((await call('POST', `/v1/notifications/${id}/read`, { as: w.lead })).status).toBe(404);
    expect((await call('POST', `/v1/notifications/${id}/read`, { as: w.director })).status).toBe(
      200,
    );
    expect(
      (await call('GET', '/v1/notifications?unread=true', { as: w.director })).body.items,
    ).toHaveLength(2);
    for (const q of ['?unread=maybe', '?limit=0', '?cursor=garbage']) {
      expect((await call('GET', `/v1/notifications${q}`, { as: w.director })).status, q).toBe(400);
    }
  });
});

describe('deactivation guards over HTTP', () => {
  it("answers 409 with the guard's code while a crew member is held or a Lead owns open missions", async () => {
    const w = await missionWorld(h, 'HTTP guards');
    await w.pending();
    const held = await call('PATCH', `/v1/users/${w.ann.userId}`, {
      as: w.director,
      body: { status: 'deactivated' },
    });
    expect(held.status).toBe(409);
    expect(held.body.code).toBe('USER_HAS_COMMITMENTS');
    const owner = await call('PATCH', `/v1/users/${w.lead.userId}`, {
      as: w.director,
      body: { status: 'deactivated' },
    });
    expect(owner.status).toBe(409);
    expect(owner.body.code).toBe('USER_OWNS_MISSIONS');
  });
});
