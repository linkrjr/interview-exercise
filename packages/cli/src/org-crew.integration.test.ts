import { uniqueEmail } from '@mc/core/testing';
import { addAssignment, addHold, addMission, openAdminDb, type AdminDb } from '@mc/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { onboardDirector, onboardMember, startE2e, type E2e } from './e2e-support.js';

const urls = inject('dbUrls');
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

describe('org settings, skills, crew profiles, crew search and the audit log, through the real mc binary', () => {
  it('works end to end', async () => {
    const { director, orgId } = await onboardDirector(e2e, uniqueEmail('director'));
    const lead = await onboardMember(director, 'lead', uniqueEmail('lead'), 'Lee Lead');
    const ann = await onboardMember(director, 'crew', uniqueEmail('ann'), 'Ann Crew');
    const bob = await onboardMember(director, 'crew', uniqueEmail('bob'), 'Bob Crew');

    // Organisation settings: Directors write, everyone reads.
    expect((await director.run(['--json', 'org', 'settings', 'show'])).json).toEqual({
      timeZone: 'UTC',
      maxUpcomingMissions: 3,
    });
    const set = await director.run([
      '--json',
      'org',
      'settings',
      'set',
      '--timezone',
      'Europe/London',
      '--max-upcoming',
      '5',
    ]);
    expect(set.json).toEqual({ timeZone: 'Europe/London', maxUpcomingMissions: 5 });
    expect((await lead.machine.run(['--json', 'org', 'settings', 'show'])).json).toEqual(set.json);
    expect((await lead.machine.run(['org', 'settings', 'set', '--max-upcoming', '9'])).code).toBe(
      2,
    );
    const badZone = await director.run(['org', 'settings', 'set', '--timezone', 'Mars/Base']);
    expect(badZone.code).toBe(1);
    expect(badZone.stderr).toContain('timeZone: Not a valid IANA time zone');
    expect((await director.run(['org', 'settings', 'set', '--max-upcoming', '99'])).code).toBe(1);

    // Skill catalogue.
    const medicine = (await director.run(['--json', 'skills', 'add', 'Medicine'])).json;
    const piloting = (await director.run(['--json', 'skills', 'add', 'Orbital Piloting'])).json;
    expect((await director.run(['skills', 'add', 'medicine'])).code).toBe(4);
    expect((await lead.machine.run(['skills', 'add', 'Nope'])).code).toBe(2);
    expect((await director.run(['skills', 'rename', piloting.id, 'Orbital Navigation'])).code).toBe(
      0,
    );
    expect((await director.run(['skills', 'rename', piloting.id, 'MEDICINE'])).code).toBe(4);
    expect((await ann.machine.run(['skills', 'list'])).stdout).toContain('Orbital Navigation');

    // Crew set their own skills, by name.
    expect((await ann.machine.run(['profile', 'skill', 'set', 'medicine', '4'])).code).toBe(0);
    expect(
      (await ann.machine.run(['profile', 'skill', 'set', 'Orbital Navigation', '5'])).code,
    ).toBe(0);
    expect((await bob.machine.run(['profile', 'skill', 'set', 'Medicine', '2'])).code).toBe(0);
    expect((await ann.machine.run(['profile', 'skill', 'set', 'Basket Weaving', '3'])).code).toBe(
      3,
    );
    expect((await ann.machine.run(['profile', 'skill', 'set', 'Medicine', '9'])).code).toBe(1);
    const shown = await ann.machine.run(['--json', 'profile', 'show']);
    expect(shown.json.skills).toEqual([
      { skillId: medicine.id, name: 'Medicine', level: 4 },
      { skillId: piloting.id, name: 'Orbital Navigation', level: 5 },
    ]);
    expect((await lead.machine.run(['profile', 'skill', 'set', 'Medicine', '3'])).code).toBe(2);
    expect((await lead.machine.run(['profile', 'show'])).code).toBe(3); // a Lead has no crew profile

    // Unavailability: own overlap, the past, privacy of the note.
    const added = await ann.machine.run([
      '--json',
      'profile',
      'unavailable',
      'add',
      '2033-10-10',
      '2033-10-20',
      '--note',
      'Medical',
    ]);
    expect(added.code, added.stderr).toBe(0);
    const overlap = await ann.machine.run([
      'profile',
      'unavailable',
      'add',
      '2033-10-20',
      '2033-10-25',
    ]);
    expect(overlap.code).toBe(4);
    expect(overlap.stderr).toContain('UNAVAILABILITY_OVERLAPS_EXISTING');
    expect(overlap.stderr).toContain('existing range 2033-10-10 to 2033-10-20');
    const past = await ann.machine.run([
      'profile',
      'unavailable',
      'add',
      '2020-01-01',
      '2020-01-05',
    ]);
    expect(past.code).toBe(1);
    expect(past.stderr).toContain('UNAVAILABILITY_IN_PAST');
    expect((await ann.machine.run(['profile', 'unavailable', 'list'])).stdout).toContain('Medical');
    const annsId = ann.userId;
    const asLead = await lead.machine.run(['--json', 'crew', 'show', annsId]);
    expect(asLead.json.unavailability).toEqual([
      { id: added.json.id, from: '2033-10-10', to: '2033-10-20' },
    ]);
    expect(JSON.stringify(asLead.json)).not.toContain('Medical');

    // Crew search.
    const names = async (...args: string[]) =>
      (
        (await lead.machine.run(['--json', 'crew', 'list', ...args])).json.items as {
          name: string;
        }[]
      )
        .map((p) => p.name)
        .sort();
    expect(await names()).toEqual(['Ann Crew', 'Bob Crew']);
    expect(await names('--skill', 'Medicine>=3')).toEqual(['Ann Crew']);
    expect(await names('--skill', 'medicine >= 2')).toEqual(['Ann Crew', 'Bob Crew']);
    expect(await names('--skill', 'Medicine>=2', '--skill', 'Orbital Navigation>=5')).toEqual([
      'Ann Crew',
    ]);
    expect(await names('--available', '2033-10-12:2033-10-14')).toEqual(['Bob Crew']);
    expect(await names('--available', '2033-10-21:2033-10-30')).toEqual(['Ann Crew', 'Bob Crew']);
    expect((await lead.machine.run(['crew', 'list', '--skill', 'Medicine'])).code).toBe(1);
    expect((await lead.machine.run(['crew', 'list', '--skill', 'Nope>=3'])).code).toBe(3);
    expect((await ann.machine.run(['--json', 'crew', 'list'])).json.items).toHaveLength(1); // a Crew Member sees only themself
    expect((await ann.machine.run(['crew', 'show', bob.userId])).code).toBe(3);

    // Removing a range frees the dates for the search again.
    expect((await ann.machine.run(['profile', 'unavailable', 'remove', added.json.id])).code).toBe(
      0,
    );
    expect(await names('--available', '2033-10-12:2033-10-14')).toEqual(['Ann Crew', 'Bob Crew']);

    // OQ-1: a mission hold blocks an unavailability range, and the CLI says which mission.
    const tenant = { orgId, leadId: lead.userId };
    const mission = await addMission(admin, tenant, '2033-11-02', '2033-11-20');
    await admin.query(
      "UPDATE missions SET name = 'Artemis Relay', status = 'approved' WHERE id = $1",
      [mission],
    );
    const assignment = await addAssignment(admin, tenant, mission, ann.userId);
    await addHold(admin, tenant, assignment, mission, ann.userId, '2033-11-02', '2033-11-20');
    const blocked = await ann.machine.run([
      'profile',
      'unavailable',
      'add',
      '2033-11-05',
      '2033-11-06',
    ]);
    expect(blocked.code).toBe(4);
    expect(blocked.stderr).toContain('UNAVAILABILITY_CONFLICTS_WITH_MISSIONS');
    expect(blocked.stderr).toContain('mission Artemis Relay (2033-11-02 to 2033-11-20, approved)');
    expect((await lead.machine.run(['--json', 'crew', 'show', ann.userId])).json.load).toBe(1);
    expect(await names('--available', '2033-11-10:2033-11-11')).toEqual(['Bob Crew']);

    // Audit log: Directors only, with the filters of the spec.
    const log = await director.run(['--json', 'audit', 'list', '--entity', `skill:${piloting.id}`]);
    expect(log.json.items.map((e: { action: string }) => e.action)).toEqual([
      'skill.renamed',
      'skill.created',
    ]);
    const settingsLog = await director.run([
      '--json',
      'audit',
      'list',
      '--entity',
      `organisation:${orgId}`,
    ]);
    expect(settingsLog.json.items[0]).toMatchObject({
      action: 'org.settings_updated',
      after: { timeZone: 'Europe/London', maxUpcomingMissions: 5 },
    });
    expect((await director.run(['audit', 'list', '--since', '2026-10-02'])).stdout).toContain(
      'crew.unavailability_added',
    );
    expect((await director.run(['audit', 'list', '--until', '2000-01-01'])).stdout.trim()).toMatch(
      /^TIME \(UTC\)\s+ACTION\s+ENTITY\s+ACTOR$/,
    );
    const everything = await director.run(['--json', 'audit', 'list', '--limit', '100']);
    expect(JSON.stringify(everything.json)).not.toContain('Medical');
    const byAnn = await director.run([
      '--json',
      'audit',
      'list',
      '--actor',
      ann.userId,
      '--limit',
      '100',
    ]);
    expect(byAnn.json.items.length).toBeGreaterThan(0);
    expect(byAnn.json.items.every((e: { actorId: string }) => e.actorId === ann.userId)).toBe(true);
    expect((await lead.machine.run(['audit', 'list'])).code).toBe(2);
    expect((await ann.machine.run(['audit', 'list'])).code).toBe(2);
    expect((await director.run(['audit', 'list', '--since', 'yesterday'])).code).toBe(1);
  });
});
