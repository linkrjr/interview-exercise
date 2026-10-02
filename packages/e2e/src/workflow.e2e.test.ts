import { describe, expect, it } from 'vitest';
import {
  Machine,
  OPERATOR_TOKEN,
  PASSWORD,
  day,
  onboardDirector,
  onboardMember,
  sql,
} from './support.js';

/**
 * The whole product through the real `mc` binary against the docker-compose stack: operator →
 * Director → Lead → Crew → approval → activation, with time moved by the test-only endpoint.
 */
describe('mission control, end to end', () => {
  // State shared by the steps below, which run in order.
  const s = {} as {
    a: Awaited<ReturnType<typeof onboardDirector>>;
    b: Awaited<ReturnType<typeof onboardDirector>>;
    lead: Awaited<ReturnType<typeof onboardMember>>;
    ann: Awaited<ReturnType<typeof onboardMember>>;
    bob: Awaited<ReturnType<typeof onboardMember>>;
    missionId: string;
  };
  const operatorEnv = { MC_OPERATOR_TOKEN: OPERATOR_TOKEN };
  const status = async (id = s.missionId) =>
    (await s.lead.machine.ok(['--json', 'missions', 'show', id])).json.status as string;
  const runScheduler = (date: string) =>
    s.a.director.ok(['--json', 'dev', 'run-scheduler', '--date', date], operatorEnv);

  it('onboards two organisations: the operator provisions, the Directors accept', async () => {
    s.a = await onboardDirector('Lunar Research Lab');
    s.b = await onboardDirector('Mars Transit Authority');
    expect(s.a.orgId).not.toBe(s.b.orgId);
    const me = await s.a.director.ok(['--json', 'auth', 'whoami']);
    expect(me.json.user.role).toBe('director');
  });

  it('lets a Director build the organisation: a Lead, crew, skills and profiles', async () => {
    s.lead = await onboardMember(s.a.director, 'lead', 'Lee Lead');
    s.ann = await onboardMember(s.a.director, 'crew', 'Ann Crew');
    s.bob = await onboardMember(s.a.director, 'crew', 'Bob Crew');
    await s.a.director.ok(['skills', 'add', 'Medicine']);
    await s.a.director.ok(['skills', 'add', 'Orbital Piloting']);
    await s.ann.machine.ok(['profile', 'skill', 'set', 'Medicine', '4']);
    await s.ann.machine.ok(['profile', 'skill', 'set', 'Orbital Piloting', '5']);
    await s.bob.machine.ok(['profile', 'skill', 'set', 'Medicine', '2']);
    const crew = await s.lead.machine.ok(['--json', 'crew', 'list', '--skill', 'Medicine>=3']);
    expect(crew.json.items.map((c: { id: string }) => c.id)).toEqual([s.ann.userId]);
  });

  it('plans a mission, lets the matcher propose the crew and submits it', async () => {
    const created = await s.lead.machine.ok([
      '--json',
      'missions',
      'create',
      '--name',
      'Artemis Relay',
      '--start',
      day(10),
      '--end',
      day(12),
    ]);
    s.missionId = created.json.id;
    await s.lead.machine.ok([
      'missions',
      'requirements',
      'set',
      s.missionId,
      '--req',
      'Orbital Piloting:4:1',
      '--req',
      'Medicine:3:1',
    ]);
    await s.lead.machine.ok(['missions', 'start-crewing', s.missionId]);

    const proposal = await s.lead.machine.ok(['--json', 'missions', 'match', s.missionId]);
    expect(proposal.json.complete).toBe(true);
    expect(proposal.json.team.map((m: { crewMemberId: string }) => m.crewMemberId)).toEqual([
      s.ann.userId,
    ]);
    await s.lead.machine.ok([
      'missions',
      'match',
      'apply',
      s.missionId,
      proposal.json.proposalId,
      '--team-hash',
      proposal.json.teamHash,
    ]);
    await s.lead.machine.ok(['missions', 'submit', s.missionId]);
    expect(await status()).toBe('pending_approval');
  });

  it('has a Director approve it, and the crew member acknowledge it', async () => {
    const pending = await s.a.director.ok(['--json', 'approvals', 'list']);
    expect(pending.json.items.map((m: { id: string }) => m.id)).toContain(s.missionId);
    await s.a.director.ok(['missions', 'approve', s.missionId, '--comment', 'Go']);
    expect(await status()).toBe('approved');

    const inbox = await s.ann.machine.ok(['--json', 'inbox']);
    expect(inbox.json.items.map((n: { type: string }) => n.type)).toContain('mission.assigned');
    const assignments = await s.ann.machine.ok(['--json', 'assignments', 'list']);
    await s.ann.machine.ok(['assignments', 'acknowledge', assignments.json.items[0].id]);
  });

  it('moves time with the test-only endpoint: activates on the start day, completes after the end', async () => {
    await runScheduler(day(9));
    expect(await status()).toBe('approved');
    await runScheduler(day(10));
    expect(await status()).toBe('active');
    await runScheduler(day(13));
    expect(await status()).toBe('completed');
    const trail = await s.a.director.ok([
      '--json',
      'audit',
      'list',
      '--entity',
      `mission:${s.missionId}`,
    ]);
    expect(trail.json.items.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['mission.activate', 'mission.complete']),
    );
  });

  it('keeps the organisations apart', async () => {
    // B's Director cannot reach A's mission, crew or audit trail: not found, never forbidden.
    expect((await s.b.director.mc(['missions', 'show', s.missionId])).code).toBe(3);
    expect((await s.b.director.mc(['crew', 'show', s.ann.userId])).code).toBe(3);
    expect((await s.b.director.ok(['--json', 'missions', 'list'])).json.items).toEqual([]);
    const audit = await s.b.director.ok(['--json', 'audit', 'list', '--limit', '100']);
    expect(JSON.stringify(audit.json)).not.toContain(s.missionId);
    expect((await s.b.director.ok(['--json', 'crew', 'list'])).json.items).toEqual([]);
    // A user of A cannot sign in to B.
    const outsider = await Machine.create();
    const login = await outsider.mc(
      ['auth', 'login', '--org', s.b.orgId, '--email', 'nobody@e2e.example', '--password-stdin'],
      {},
      `${PASSWORD}\n`,
    );
    expect(login.code).toBe(2);
  });

  it('raises an alert when the scheduler fails for an organisation, visible through mc alerts', async () => {
    expect((await s.a.director.ok(['alerts'])).stdout).toContain('No alerts.');

    // A second mission to activate, and a database that refuses to update this organisation's missions.
    const created = await s.lead.machine.ok([
      '--json',
      'missions',
      'create',
      '--name',
      'Second Relay',
      '--start',
      day(20),
      '--end',
      day(22),
    ]);
    const id = created.json.id as string;
    await s.lead.machine.ok(['missions', 'requirements', 'set', id, '--req', 'Medicine:3:1']);
    await s.lead.machine.ok(['missions', 'start-crewing', id]);
    await s.lead.machine.ok(['missions', 'crew', 'set', id, s.ann.userId]);
    await s.lead.machine.ok(['missions', 'submit', id]);
    await s.a.director.ok(['missions', 'approve', id]);

    expect(
      (
        await sql(
          `CREATE FUNCTION e2e_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$`,
        )
      ).code,
    ).toBe(0);
    expect(
      (
        await sql(
          `CREATE TRIGGER e2e_refuse BEFORE UPDATE ON missions FOR EACH ROW WHEN (NEW.org_id = '${s.a.orgId}') EXECUTE FUNCTION e2e_refuse()`,
        )
      ).code,
    ).toBe(0);
    try {
      const run = await runScheduler(day(20));
      const mine = run.json.organisations.find(
        (o: { organisationId: string }) => o.organisationId === s.a.orgId,
      );
      expect(mine).toMatchObject({ status: 'failed', alertWritten: true });
    } finally {
      await sql('DROP TRIGGER e2e_refuse ON missions');
      await sql('DROP FUNCTION e2e_refuse()');
    }
    expect(await status(id)).toBe('approved'); // rolled back

    const alerts = await s.a.director.ok(['--json', 'alerts']);
    expect(alerts.json.items).toHaveLength(1);
    expect(alerts.json.items[0]).toMatchObject({
      source: 'scheduler',
      code: 'SCHEDULER_RUN_FAILED',
    });
    expect((await s.b.director.ok(['--json', 'alerts'])).json.items).toEqual([]);
    expect((await s.lead.machine.mc(['alerts'])).code).toBe(2);

    // The next pass retries and succeeds.
    await runScheduler(day(20));
    expect(await status(id)).toBe('active');
  });

  it('seeds the demo scenario', async () => {
    const operator = await Machine.create();
    const seeded = await operator.ok(['--json', 'dev', 'seed', '--scenario', 'demo'], operatorEnv);
    expect(seeded.json.organisations.map((o: { name: string }) => o.name)).toEqual([
      'Lunar Gateway Operations',
      'Mars Transit Authority',
    ]);
    const director = await Machine.create();
    await director.ok(
      [
        'auth',
        'login',
        '--org',
        seeded.json.organisations[0].id,
        '--email',
        'director@lunar-gateway.example',
        '--password-stdin',
      ],
      {},
      `${seeded.json.password}\n`,
    );
    const missions = await director.ok(['--json', 'missions', 'list', '--limit', '100']);
    expect(missions.json.items).toHaveLength(7);
  });
});
