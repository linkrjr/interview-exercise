import { newId } from '@mc/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createHarness,
  onboardUser,
  provisionOrganisation,
  type Harness,
  type ProvisionedOrg,
} from '../testing/index.js';

const urls = inject('dbUrls');
let h: Harness;
let org: ProvisionedOrg;

beforeAll(async () => {
  h = await createHarness(urls);
  org = await provisionOrganisation(h, 'Skills Org');
});

afterAll(async () => {
  await h.close();
});

const names = async (actor = org.director.actor) =>
  (await h.skills.list(actor, { limit: 100 })).items.map((s) => s.name);

describe('catalogue', () => {
  it('lets a Director add skills and everyone read them', async () => {
    const lead = await onboardUser(h, org, 'lead');
    const crew = await onboardUser(h, org, 'crew');
    const created = await h.skills.create(org.director.actor, { name: 'Orbital Piloting' });
    expect(created).toMatchObject({
      name: 'Orbital Piloting',
      id: expect.any(String),
      createdAt: expect.any(String),
    });
    for (const actor of [org.director.actor, lead.actor, crew.actor]) {
      expect(await names(actor)).toContain('Orbital Piloting');
    }
  });

  it('forbids Leads and Crew from adding or renaming', async () => {
    const lead = await onboardUser(h, org, 'lead');
    const crew = await onboardUser(h, org, 'crew');
    const skill = await h.skills.create(org.director.actor, { name: 'Welding' });
    for (const actor of [lead.actor, crew.actor]) {
      await expect(h.skills.create(actor, { name: 'Nope' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
      await expect(h.skills.rename(actor, skill.id, { name: 'Nope' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
    expect(await names()).not.toContain('Nope');
  });

  it('keeps names unique per organisation, ignoring case', async () => {
    await h.skills.create(org.director.actor, { name: 'Medicine' });
    for (const name of ['Medicine', 'medicine', 'MEDICINE']) {
      await expect(h.skills.create(org.director.actor, { name })).rejects.toMatchObject({
        code: 'SKILL_NAME_TAKEN',
        status: 409,
      });
    }
  });

  it('allows the same name in another organisation', async () => {
    const other = await provisionOrganisation(h, 'Other');
    await expect(
      h.skills.create(other.director.actor, { name: 'Medicine' }),
    ).resolves.toMatchObject({ name: 'Medicine' });
  });

  it('audits creation', async () => {
    h.audit.clear();
    const skill = await h.skills.create(org.director.actor, { name: 'Geology' });
    expect(h.audit.forEntity('skill', skill.id)).toEqual([
      expect.objectContaining({
        action: 'skill.created',
        after: { name: 'Geology' },
        actorId: org.director.userId,
      }),
    ]);
  });
});

describe('rename', () => {
  it('renames, keeping the id, and audits before and after', async () => {
    const skill = await h.skills.create(org.director.actor, { name: 'Nav' });
    h.audit.clear();
    const renamed = await h.skills.rename(org.director.actor, skill.id, { name: 'Navigation' });
    expect(renamed).toMatchObject({ id: skill.id, name: 'Navigation' });
    expect(await names()).not.toContain('Nav');
    expect(h.audit.forEntity('skill', skill.id)).toEqual([
      expect.objectContaining({
        action: 'skill.renamed',
        before: { name: 'Nav' },
        after: { name: 'Navigation' },
      }),
    ]);
  });

  it('can change only the case of a name, and treats an identical name as a no-op', async () => {
    const skill = await h.skills.create(org.director.actor, { name: 'ecology' });
    expect((await h.skills.rename(org.director.actor, skill.id, { name: 'Ecology' })).name).toBe(
      'Ecology',
    );
    h.audit.clear();
    await h.skills.rename(org.director.actor, skill.id, { name: 'Ecology' });
    expect(h.audit.events).toEqual([]);
  });

  it('refuses a name another skill has, ignoring case', async () => {
    const a = await h.skills.create(org.director.actor, { name: 'Alpha Skill' });
    await h.skills.create(org.director.actor, { name: 'Beta Skill' });
    await expect(
      h.skills.rename(org.director.actor, a.id, { name: 'beta skill' }),
    ).rejects.toMatchObject({
      code: 'SKILL_NAME_TAKEN',
    });
    expect(
      (await h.skills.list(org.director.actor, { limit: 100 })).items.find((s) => s.id === a.id)
        ?.name,
    ).toBe('Alpha Skill');
  });

  it("answers 404 for unknown skills and for another organisation's skill", async () => {
    const other = await provisionOrganisation(h, 'Foreign');
    const foreign = await h.skills.create(other.director.actor, { name: 'Foreign Skill' });
    await expect(h.skills.rename(org.director.actor, newId(), { name: 'X' })).rejects.toMatchObject(
      { status: 404 },
    );
    await expect(
      h.skills.rename(org.director.actor, foreign.id, { name: 'Hijacked' }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    expect(await names(other.director.actor)).toContain('Foreign Skill');
  });
});

describe('list', () => {
  it('pages through the organisation skills only', async () => {
    const mine = await provisionOrganisation(h, 'Paging');
    for (const n of ['One', 'Two', 'Three', 'Four', 'Five'])
      await h.skills.create(mine.director.actor, { name: n });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await h.skills.list(mine.director.actor, { limit: 2, cursor });
      seen.push(...page.items.map((s) => s.name));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(['One', 'Two', 'Three', 'Four', 'Five']);
    await expect(
      h.skills.list(mine.director.actor, { limit: 5, cursor: 'garbage' }),
    ).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
  });
});
