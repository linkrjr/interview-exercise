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

async function call(
  application: ReturnType<typeof buildApp>,
  method: 'GET' | 'POST',
  url: string,
  options: { as?: Person; body?: unknown; version?: number | string } = {},
) {
  const token = options.as
    ? await h.accessTokens.sign({
        userId: options.as.userId,
        orgId: options.as.actor.orgId,
        role: options.as.actor.role,
      })
    : undefined;
  const res = await application.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.version !== undefined ? { 'if-match': String(options.version) } : {}),
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
const http = (method: 'GET' | 'POST', url: string, options: Parameters<typeof call>[3] = {}) =>
  call(app, method, url, options);

async function crewingWorld(label: string) {
  const w = await missionWorld(h, label);
  const m = await w.crewing({ requirements: [{ skillId: w.medicine.id, minLevel: 3, count: 1 }] });
  return { w, m };
}

describe('POST /v1/missions/{id}/match', () => {
  it('returns the proposal of DESIGN.md §9.4, with a proposal id, a team hash and an expiry', async () => {
    const { w, m } = await crewingWorld('HTTP match');
    const res = await http('POST', `/v1/missions/${m.id}/match`, { as: w.lead, body: {} });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      proposalId: expect.any(String),
      missionId: m.id,
      method: 'exact',
      complete: true,
      team: [
        {
          crewMemberId: w.ann.userId,
          name: 'ann person',
          email: w.ann.email,
          upcomingMissions: 0,
          covers: [{ skillId: w.medicine.id, skill: 'Medicine', level: 4, required: 3 }],
        },
      ],
      coverage: [{ skillId: w.medicine.id, skill: 'Medicine', minLevel: 3, required: 1, met: 1 }],
      alternates: [{ skillId: w.medicine.id, skill: 'Medicine', candidates: [] }],
      teamHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      missionVersion: m.version,
      expiresAt: expect.any(String),
    });
  });

  it('works without a body, and with excluded people', async () => {
    const { w, m } = await crewingWorld('HTTP match body');
    expect((await http('POST', `/v1/missions/${m.id}/match`, { as: w.lead })).status).toBe(200);
    const none = await http('POST', `/v1/missions/${m.id}/match`, {
      as: w.lead,
      body: { exclude: [w.ann.userId] },
    });
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ complete: false, team: [] });
    expect(none.body.coverage[0].gap).toEqual({
      qualifiedTotal: 1,
      blocked: { UNAVAILABLE: 0, COMMITTED: 0, AT_CAPACITY: 0, EXCLUDED: 1 },
    });
  });

  it('has no way to pin: unknown keys are refused rather than ignored', async () => {
    const { w, m } = await crewingWorld('HTTP match pin');
    for (const body of [
      { pin: [w.ann.userId] },
      { exclude: [], force: true },
      { include: [w.ann.userId] },
    ]) {
      const res = await http('POST', `/v1/missions/${m.id}/match`, { as: w.lead, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('validates the excluded ids', async () => {
    const { w, m } = await crewingWorld('HTTP match invalid');
    const bad: Array<[Json, number]> = [
      [{ exclude: ['nope'] }, 400],
      [{ exclude: [w.ann.userId, w.ann.userId] }, 400],
      [{ exclude: 'x' }, 400],
      [{ exclude: [newId()] }, 400], // not a crew member of the organisation
      [{ exclude: [w.lead2.userId] }, 400], // a Lead
    ];
    for (const [body, status] of bad)
      expect(
        (await http('POST', `/v1/missions/${m.id}/match`, { as: w.lead, body })).status,
        JSON.stringify(body),
      ).toBe(status);
    const refused = await http('POST', `/v1/missions/${m.id}/match`, {
      as: w.lead,
      body: { exclude: [w.lead2.userId] },
    });
    expect(refused.body).toMatchObject({
      code: 'CREW_MEMBER_NOT_ASSIGNABLE',
      crewMemberIds: [w.lead2.userId],
    });
  });

  it("requires a signed-in owning Lead, a Crewing mission, and an organisation's own mission", async () => {
    const { w, m } = await crewingWorld('HTTP match access');
    const other = await crewingWorld('HTTP match access other');
    expect((await http('POST', `/v1/missions/${m.id}/match`, { body: {} })).status).toBe(401);
    for (const who of [w.lead2, w.director, w.ann]) {
      const res = await http('POST', `/v1/missions/${m.id}/match`, { as: who, body: {} });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
    for (const id of [newId(), other.m.id, 'not-a-uuid']) {
      expect(
        (await http('POST', `/v1/missions/${id}/match`, { as: w.lead, body: {} })).status,
      ).toBe(404);
    }
    const draft = await w.draft();
    const res = await http('POST', `/v1/missions/${draft.id}/match`, { as: w.lead, body: {} });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      status: 409,
      code: 'MISSION_NOT_EDITABLE',
      missionStatus: 'draft',
    });
  });
});

describe('POST /v1/missions/{id}/match/{proposalId}/apply', () => {
  it('applies a proposal, then the Lead submits and a Director approves it', async () => {
    const { w, m } = await crewingWorld('HTTP apply');
    const proposal = (await http('POST', `/v1/missions/${m.id}/match`, { as: w.lead, body: {} }))
      .body;
    const applied = await http('POST', `/v1/missions/${m.id}/match/${proposal.proposalId}/apply`, {
      as: w.lead,
      body: { teamHash: proposal.teamHash },
      version: m.version,
    });
    expect(applied.status).toBe(200);
    expect(applied.headers.etag).toBe(`"${m.version + 1}"`);
    expect(applied.body.crew.map((c: Json) => c.crewMemberId)).toEqual([w.ann.userId]);
    expect(applied.body.crewValidation).toEqual({
      valid: true,
      assignmentIssues: [],
      unmetRequirements: [],
    });
    const submitted = await http('POST', `/v1/missions/${m.id}/transitions`, {
      as: w.lead,
      body: { action: 'submit' },
      version: applied.body.version,
    });
    expect(submitted.body.status).toBe('pending_approval');
  });

  it('needs If-Match, the proposal id of this mission, and the hash', async () => {
    const { w, m } = await crewingWorld('HTTP apply needs');
    const proposal = (await http('POST', `/v1/missions/${m.id}/match`, { as: w.lead, body: {} }))
      .body;
    const url = `/v1/missions/${m.id}/match/${proposal.proposalId}/apply`;
    expect(
      (await http('POST', url, { as: w.lead, body: { teamHash: proposal.teamHash } })).status,
    ).toBe(428);
    expect(
      (
        await http('POST', url, {
          as: w.lead,
          body: { teamHash: proposal.teamHash },
          version: 'abc',
        })
      ).status,
    ).toBe(400);
    for (const body of [
      {},
      { teamHash: 'short' },
      { teamHash: 'Z'.repeat(64) },
      { teamHash: proposal.teamHash, extra: 1 },
    ]) {
      expect(
        (await http('POST', url, { as: w.lead, body, version: m.version })).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    const stale = await http('POST', url, {
      as: w.lead,
      body: { teamHash: proposal.teamHash },
      version: m.version - 1,
    });
    expect(stale.status).toBe(412);
    expect(stale.body).toMatchObject({
      code: 'MISSION_VERSION_MISMATCH',
      currentVersion: m.version,
    });
  });

  it('reports a wrong hash, a stale proposal and an expired one as 409s with their own codes', async () => {
    const { w, m } = await crewingWorld('HTTP apply 409');
    const proposal = (await http('POST', `/v1/missions/${m.id}/match`, { as: w.lead, body: {} }))
      .body;
    const url = `/v1/missions/${m.id}/match/${proposal.proposalId}/apply`;
    const wrong = await http('POST', url, {
      as: w.lead,
      body: { teamHash: '0'.repeat(64) },
      version: m.version,
    });
    expect(wrong).toMatchObject({ status: 409, body: { code: 'MATCH_TEAM_HASH_MISMATCH' } });

    const edited = (
      await http('POST', `/v1/missions/${m.id}/transitions`, {
        as: w.lead,
        body: { action: 'reopen' },
        version: m.version,
      })
    ).body;
    const stale = await http('POST', url, {
      as: w.lead,
      body: { teamHash: proposal.teamHash },
      version: edited.version,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'MATCH_PROPOSAL_STALE',
      proposalVersion: m.version,
      currentVersion: edited.version,
    });

    const second = await crewingWorld('HTTP apply expired');
    const p2 = (
      await http('POST', `/v1/missions/${second.m.id}/match`, { as: second.w.lead, body: {} })
    ).body;
    h.clock.advance(31 * 60_000);
    const expired = await http('POST', `/v1/missions/${second.m.id}/match/${p2.proposalId}/apply`, {
      as: second.w.lead,
      body: { teamHash: p2.teamHash },
      version: second.m.version,
    });
    expect(expired.status).toBe(409);
    expect(expired.body.code).toBe('MATCH_PROPOSAL_EXPIRED');
  });

  it("answers 404 for unknown, malformed and other organisations' proposals, and 403 for the wrong role", async () => {
    const { w, m } = await crewingWorld('HTTP apply 404');
    const other = await crewingWorld('HTTP apply 404 other');
    const proposal = (await http('POST', `/v1/missions/${m.id}/match`, { as: w.lead, body: {} }))
      .body;
    const theirs = (
      await http('POST', `/v1/missions/${other.m.id}/match`, { as: other.w.lead, body: {} })
    ).body;
    for (const id of [newId(), 'not-a-uuid', theirs.proposalId]) {
      const res = await http('POST', `/v1/missions/${m.id}/match/${id}/apply`, {
        as: w.lead,
        body: { teamHash: proposal.teamHash },
        version: m.version,
      });
      expect(res.status, id).toBe(404);
    }
    expect(
      (
        await http('POST', `/v1/missions/${other.m.id}/match/${theirs.proposalId}/apply`, {
          as: w.lead,
          body: { teamHash: theirs.teamHash },
          version: other.m.version,
        })
      ).status,
    ).toBe(404);
    for (const who of [w.lead2, w.director, w.ann]) {
      const res = await http('POST', `/v1/missions/${m.id}/match/${proposal.proposalId}/apply`, {
        as: who,
        body: { teamHash: proposal.teamHash },
        version: m.version,
      });
      expect(res.status).toBe(403);
    }
    expect(
      (
        await http('POST', `/v1/missions/${m.id}/match/${proposal.proposalId}/apply`, {
          body: { teamHash: proposal.teamHash },
          version: m.version,
        })
      ).status,
    ).toBe(401);
  });
});

describe('the per-user rate limit on matching (mechanism; the number is set by spec 06)', () => {
  const limited = () =>
    buildApp({
      services: h,
      accessTokens: h.accessTokens,
      operatorToken: OPERATOR,
      loginRate: { emailMax: 50, ipMax: 500, windowMs: 60_000 },
      matchRate: { max: 2, windowMs: 60_000 },
      clock: h.clock,
    });

  it('allows the configured number per user and then answers 429 with Retry-After', async () => {
    const { w, m } = await crewingWorld('HTTP rate');
    const other = await crewingWorld('HTTP rate other');
    const a = limited();
    try {
      const match = (who: Person, id: string) =>
        call(a, 'POST', `/v1/missions/${id}/match`, { as: who, body: {} });
      expect((await match(w.lead, m.id)).status).toBe(200);
      expect((await match(w.lead, m.id)).status).toBe(200);
      const blocked = await match(w.lead, m.id);
      expect(blocked.status).toBe(429);
      expect(blocked.headers['content-type']).toContain('application/problem+json');
      expect(blocked.body).toMatchObject({
        code: 'RATE_LIMITED',
        status: 429,
        retryAfterSeconds: expect.any(Number),
      });
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      // Another user is not affected, and applying is not limited.
      expect((await match(other.w.lead, other.m.id)).status).toBe(200);
      const proposal = (
        await call(a, 'POST', `/v1/missions/${other.m.id}/match`, { as: other.w.lead, body: {} })
      ).body;
      expect(proposal.proposalId).toBeDefined();
      for (let i = 0; i < 3; i++) {
        const res = await call(
          a,
          'POST',
          `/v1/missions/${other.m.id}/match/${proposal.proposalId}/apply`,
          { as: other.w.lead, body: { teamHash: proposal.teamHash }, version: other.m.version },
        );
        expect(res.status).not.toBe(429);
      }
      // The window slides: after it has passed, the Lead can match again.
      h.clock.advance(61_000);
      expect((await match(w.lead, m.id)).status).toBe(200);
    } finally {
      await a.close();
    }
  });

  it('does not count requests that were invalid, and is off unless configured', async () => {
    const { w, m } = await crewingWorld('HTTP rate invalid');
    const a = limited();
    try {
      for (let i = 0; i < 5; i++)
        expect(
          (await call(a, 'POST', `/v1/missions/${m.id}/match`, { as: w.lead, body: { pin: [] } }))
            .status,
        ).toBe(400);
      expect(
        (await call(a, 'POST', `/v1/missions/${m.id}/match`, { as: w.lead, body: {} })).status,
      ).toBe(200);
    } finally {
      await a.close();
    }
    for (let i = 0; i < 5; i++)
      expect(
        (await http('POST', `/v1/missions/${m.id}/match`, { as: w.lead, body: {} })).status,
      ).toBe(200);
  });
});

void ({} as MissionWorld);
