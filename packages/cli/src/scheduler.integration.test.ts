import { uniqueEmail } from '@mc/core/testing';
import { openAdminDb, type AdminDb } from '@mc/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  OPERATOR_TOKEN,
  PASSWORD,
  onboardDirector,
  onboardMember,
  startE2e,
  type E2e,
} from './e2e-support.js';

const urls = inject('dbUrls');
const operatorEnv = { MC_OPERATOR_TOKEN: OPERATOR_TOKEN };
let e2e: E2e;
let admin: AdminDb;

beforeAll(async () => {
  e2e = await startE2e(urls);
  admin = openAdminDb(urls.migrator);
});
afterAll(async () => {
  await e2e.stop();
  await admin.end();
});

describe('time passing, through mc dev run-scheduler', () => {
  it('activates an approved mission on its start day and completes it after its end', async () => {
    const { director } = await onboardDirector(e2e, uniqueEmail('director'));
    const lead = await onboardMember(director, 'lead', uniqueEmail('lead'), 'Lee Lead');
    const ann = await onboardMember(director, 'crew', uniqueEmail('ann'), 'Ann Crew');
    await director.run(['skills', 'add', 'Medicine']);
    await ann.machine.run(['profile', 'skill', 'set', 'Medicine', '4']);

    const created = await lead.machine.run([
      '--json',
      'missions',
      'create',
      '--name',
      'Relay',
      '--start',
      '2026-10-10',
      '--end',
      '2026-10-12',
    ]);
    const id = created.json.id as string;
    await lead.machine.run(['missions', 'requirements', 'set', id, '--req', 'Medicine:3:1']);
    await lead.machine.run(['missions', 'start-crewing', id]);
    await lead.machine.run(['missions', 'crew', 'set', id, ann.userId]);
    expect((await lead.machine.run(['missions', 'submit', id])).code).toBe(0);
    expect((await director.run(['missions', 'approve', id])).code).toBe(0);
    const assignments = await ann.machine.run(['--json', 'assignments', 'list']);
    expect(
      (await ann.machine.run(['assignments', 'acknowledge', assignments.json.items[0].id])).code,
    ).toBe(0);

    const status = async () =>
      (await lead.machine.run(['--json', 'missions', 'show', id])).json.status as string;
    const runOn = (date: string) =>
      lead.machine.run(['--json', 'dev', 'run-scheduler', '--date', date], operatorEnv);

    expect((await runOn('2026-10-09')).code).toBe(0);
    expect(await status()).toBe('approved');
    const started = await runOn('2026-10-10');
    expect(started.code, started.stderr).toBe(0);
    expect(await status()).toBe('active');
    expect(await runOn('2026-10-12').then(() => status())).toBe('active');
    await runOn('2026-10-13');
    expect(await status()).toBe('completed');

    // The scheduler acted as the system, and the Director can see it.
    const audit = await director.run(['--json', 'audit', 'list', '--entity', `mission:${id}`]);
    expect(
      audit.json.items
        .filter((e: { actorId: unknown }) => e.actorId === null)
        .map((e: { action: string }) => e.action),
    ).toEqual(['mission.complete', 'mission.activate']);
  });

  it('needs the operator token', async () => {
    const machine = await e2e.machine();
    expect((await machine.run(['dev', 'run-scheduler', '--date', '2026-10-10'])).code).toBe(1);
    expect(
      (
        await machine.run(['dev', 'run-scheduler', '--date', '2026-10-10'], {
          MC_OPERATOR_TOKEN: 'wrong-token-wrong-token-wrong-token',
        })
      ).code,
    ).toBe(2);
  });
});

/** An organisation with one Approved mission starting on 2026-10-10, ready for the scheduler to activate. */
async function approvedMissionOrg(name: string) {
  const org = await onboardDirector(e2e, uniqueEmail('director'), name);
  const lead = await onboardMember(org.director, 'lead', uniqueEmail('lead'), 'Lee Lead');
  const ann = await onboardMember(org.director, 'crew', uniqueEmail('ann'), 'Ann Crew');
  await org.director.run(['skills', 'add', 'Medicine']);
  await ann.machine.run(['profile', 'skill', 'set', 'Medicine', '4']);
  const created = await lead.machine.run([
    '--json',
    'missions',
    'create',
    '--name',
    'Relay',
    '--start',
    '2026-10-10',
    '--end',
    '2026-10-12',
  ]);
  const id = created.json.id as string;
  await lead.machine.run(['missions', 'requirements', 'set', id, '--req', 'Medicine:3:1']);
  await lead.machine.run(['missions', 'start-crewing', id]);
  await lead.machine.run(['missions', 'crew', 'set', id, ann.userId]);
  await lead.machine.run(['missions', 'submit', id]);
  await org.director.run(['missions', 'approve', id]);
  return { ...org, lead, missionId: id };
}

describe('a scheduler failure, through mc alerts', () => {
  it('raises an alert the Director can read, and nobody else', async () => {
    const a = await approvedMissionOrg('Failing Org');
    const b = await approvedMissionOrg('Healthy Org');
    expect((await a.director.run(['alerts'])).stdout).toContain('No alerts.');

    // The database refuses to activate missions of the first organisation: its pass fails, rolls
    // back as a whole and raises an alert, while the other organisation is still processed.
    await admin.query(`
      CREATE FUNCTION refuse_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused for the test'; END $$`);
    await admin.query(`
      CREATE TRIGGER refuse_update BEFORE UPDATE ON missions
      FOR EACH ROW WHEN (NEW.org_id = '${a.orgId}') EXECUTE FUNCTION refuse_update()`);
    try {
      const run = await a.director.run(
        ['--json', 'dev', 'run-scheduler', '--date', '2026-10-10'],
        operatorEnv,
      );
      expect(run.code, run.stderr).toBe(0);
      const byOrg = Object.fromEntries(
        run.json.organisations.map((o: { organisationId: string }) => [o.organisationId, o]),
      );
      expect(byOrg[a.orgId]).toMatchObject({ status: 'failed', alertWritten: true });
      expect(byOrg[b.orgId]).toMatchObject({ status: 'ok', activated: 1 });
    } finally {
      await admin.query('DROP TRIGGER refuse_update ON missions');
      await admin.query('DROP FUNCTION refuse_update()');
    }

    const state = async (x: typeof a) =>
      (await x.lead.machine.run(['--json', 'missions', 'show', x.missionId])).json.status;
    expect(await state(a)).toBe('approved'); // rolled back
    expect(await state(b)).toBe('active');

    const alerts = await a.director.run(['--json', 'alerts']);
    expect(alerts.code, alerts.stderr).toBe(0);
    expect(alerts.json.items).toHaveLength(1);
    expect(alerts.json.items[0]).toMatchObject({
      source: 'scheduler',
      code: 'SCHEDULER_RUN_FAILED',
      details: { stage: 'transitions', today: '2026-10-10' },
    });
    expect(JSON.stringify(alerts.json)).not.toContain('refused for the test');
    expect((await a.director.run(['alerts'])).stdout).toContain('SCHEDULER_RUN_FAILED');
    expect((await a.director.run(['alerts', '--since', '2999-01-01'])).stdout).toContain(
      'No alerts.',
    );

    // The next pass retries it.
    await a.director.run(['dev', 'run-scheduler', '--date', '2026-10-10'], operatorEnv);
    expect(await state(a)).toBe('active');

    // Tenant isolation, and the role matrix.
    expect((await b.director.run(['--json', 'alerts'])).json.items).toEqual([]);
    expect((await a.lead.machine.run(['alerts'])).code).toBe(2);
  });
});

describe('mc dev seed', () => {
  it('seeds the demo scenario, whose users can then sign in and see their missions', async () => {
    const operator = await e2e.machine();
    const seeded = await operator.run(['--json', 'dev', 'seed', '--scenario', 'demo'], operatorEnv);
    expect(seeded.code, seeded.stderr).toBe(0);
    expect(seeded.json.organisations).toHaveLength(2);

    const lunar = seeded.json.organisations[0];
    const director = await e2e.machine();
    const login = await director.run(
      [
        'auth',
        'login',
        '--org',
        lunar.id,
        '--email',
        'director@lunar-gateway.example',
        '--password-stdin',
      ],
      {},
      `${seeded.json.password}\n`,
    );
    expect(login.code, login.stderr).toBe(0);
    const list = await director.run(['--json', 'missions', 'list', '--limit', '100']);
    expect(list.json.items.map((m: { status: string }) => m.status).sort()).toEqual([
      'active',
      'approved',
      'cancelled',
      'completed',
      'crewing',
      'draft',
      'pending_approval',
    ]);

    const again = await operator.run(['dev', 'seed'], operatorEnv);
    expect(again.code).toBe(4);
    expect(PASSWORD).toBeDefined();
  });
});

describe('a server without the test-only endpoints (production)', () => {
  it('answers mc dev commands with a clear not-found', async () => {
    const production = await startE2e(urls, { testSupport: false });
    try {
      const machine = await production.machine();
      const seed = await machine.run(['dev', 'seed'], operatorEnv);
      expect(seed.code).toBe(3);
      expect(seed.stderr).toContain('non-production builds');
      const run = await machine.run(['dev', 'run-scheduler', '--date', '2026-10-10'], operatorEnv);
      expect(run.code).toBe(3);
    } finally {
      await production.stop();
    }
  });
});
