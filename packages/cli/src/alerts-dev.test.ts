import { describe, expect, it } from 'vitest';
import { runCli } from './program.js';
import { SESSION, makeCli, problem, type Responder } from './test-support.js';

const ALERT = {
  id: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001',
  source: 'scheduler',
  code: 'SCHEDULER_RUN_FAILED',
  message: 'The scheduler could not process this organisation.',
  details: { stage: 'time_zone' },
  occurredAt: '2026-09-03T10:00:00.000Z',
};

async function signedIn(respond: Responder) {
  const cli = await makeCli(respond);
  await cli.store.setCredentials({ orgId: SESSION.orgId, accessToken: 'tok', refreshToken: 'ref' });
  return cli;
}

describe('mc alerts', () => {
  it('lists alerts, newest first, and passes the filters on', async () => {
    const cli = await signedIn(() => ({
      status: 200,
      body: { items: [ALERT], nextCursor: 'next' },
    }));
    expect(await runCli(['alerts', '--since', '2026-09-01', '--limit', '5'], cli.deps)).toBe(0);
    const url = new URL(cli.calls[0]!.url);
    expect(url.pathname).toBe('/v1/alerts');
    expect(Object.fromEntries(url.searchParams)).toEqual({ since: '2026-09-01', limit: '5' });
    expect(cli.calls[0]!.headers.authorization).toBe('Bearer tok');
    const out = cli.out.join('');
    expect(out).toContain('SCHEDULER_RUN_FAILED');
    expect(out).toContain('2026-09-03T10:00:00.000Z');
    expect(out).toContain('mc alerts --cursor next');
  });

  it('says so when there are none, and prints JSON on request', async () => {
    const empty = await signedIn(() => ({ status: 200, body: { items: [], nextCursor: null } }));
    expect(await runCli(['alerts'], empty.deps)).toBe(0);
    expect(empty.out.join('')).toContain('No alerts.');
    const json = await signedIn(() => ({
      status: 200,
      body: { items: [ALERT], nextCursor: null },
    }));
    expect(await runCli(['--json', 'alerts'], json.deps)).toBe(0);
    expect(JSON.parse(json.out.join('')).items[0].code).toBe('SCHEDULER_RUN_FAILED');
  });

  it('exits 2 for someone who is not a Director', async () => {
    const cli = await signedIn(() => ({ status: 403, body: problem(403, 'FORBIDDEN') }));
    expect(await runCli(['alerts'], cli.deps)).toBe(2);
  });
});

describe('mc dev', () => {
  const env = { MC_OPERATOR_TOKEN: 'operator-token' };
  const SEEDED = {
    scenario: 'demo',
    password: 'demo-password-123',
    organisations: [
      {
        id: SESSION.orgId,
        name: 'Lunar Gateway Operations',
        timeZone: 'Europe/London',
        users: [
          { role: 'director', name: 'Grace Hopper', email: 'director@lunar-gateway.example' },
        ],
        missions: [{ name: 'Surface Survey Alpha', status: 'active' }],
      },
    ],
  };

  it('seeds the demo scenario with the operator token and prints the logins', async () => {
    const cli = await makeCli(() => ({ status: 200, body: SEEDED }), { env });
    expect(await runCli(['dev', 'seed', '--scenario', 'demo'], cli.deps)).toBe(0);
    expect(cli.calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://api.test/v1/test/seed',
      body: { scenario: 'demo' },
    });
    expect(cli.calls[0]!.headers.authorization).toBe('Bearer operator-token');
    const out = cli.out.join('');
    expect(out).toContain('demo-password-123');
    expect(out).toContain(SESSION.orgId);
    expect(out).toContain('director@lunar-gateway.example');
    expect(out).toContain('Surface Survey Alpha');
  });

  it('runs one scheduler pass for a date', async () => {
    const cli = await makeCli(
      () => ({
        status: 200,
        body: {
          alertsPurged: 0,
          organisations: [
            { organisationId: SESSION.orgId, status: 'ok', expired: 0, activated: 1, completed: 2 },
            { organisationId: 'other', status: 'failed', alertWritten: true },
          ],
        },
      }),
      { env },
    );
    expect(await runCli(['dev', 'run-scheduler', '--date', '2027-03-02'], cli.deps)).toBe(0);
    expect(cli.calls[0]).toMatchObject({
      url: 'http://api.test/v1/test/scheduler/run',
      body: { today: '2027-03-02' },
    });
    const out = cli.out.join('');
    expect(out).toContain('activated 1, completed 2');
    expect(out).toContain('failed, alert raised');
  });

  it('needs the operator token', async () => {
    const cli = await makeCli(() => ({ status: 200 }));
    expect(await runCli(['dev', 'seed'], cli.deps)).toBe(1);
    expect(await runCli(['dev', 'run-scheduler', '--date', '2027-03-02'], cli.deps)).toBe(1);
    expect(cli.calls).toEqual([]);
  });

  it('explains a 404 from a production server', async () => {
    const cli = await makeCli(() => ({ status: 404, body: problem(404, 'NOT_FOUND') }), { env });
    expect(await runCli(['dev', 'seed'], cli.deps)).toBe(3);
    expect(cli.err.join('')).toContain('only in non-production builds');
  });

  it('reports a database that is already seeded as a conflict', async () => {
    const cli = await makeCli(() => ({ status: 409, body: problem(409, 'SEED_ALREADY_APPLIED') }), {
      env,
    });
    expect(await runCli(['dev', 'seed'], cli.deps)).toBe(4);
  });
});
