import { newId } from '@mc/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createHarness,
  missionWorld,
  onboardUser,
  type Harness,
  type MissionWorld,
} from '../testing/index.js';

const urls = inject('dbUrls');
let h: Harness;

beforeAll(async () => {
  h = await createHarness(urls);
});
afterAll(async () => {
  await h.close();
});

type Person = { actor: Parameters<Harness['notifications']['list']>[0] };
const inbox = async (who: Person) => (await h.notifications.list(who.actor, { limit: 100 })).items;
const types = async (who: Person) => (await inbox(who)).map((n) => n.type);

/** Everyone in the organisation, with an extra Director, a deactivated Director and an invited one. */
async function cast(label: string) {
  const x = await missionWorld(h, label);
  const director2 = await onboardUser(h, x.org, 'director', 'director2');
  const retired = await onboardUser(h, x.org, 'director', 'retired');
  await h.users.update(x.director.actor, retired.userId, { status: 'deactivated' });
  await h.users.invite(x.director.actor, {
    email: `pending-${newId()}@test.space`,
    role: 'director',
  });
  return { x, director2, retired };
}

describe('who is notified of what (DESIGN.md §17)', () => {
  it('Submitted: every active Director, and nobody else', async () => {
    const { x, director2, retired } = await cast('Notify submit');
    await x.pending();
    expect(await types(x.director)).toEqual(['mission.submitted']);
    expect(await types(director2)).toEqual(['mission.submitted']);
    for (const other of [retired, x.lead, x.lead2, x.ann, x.bob])
      expect(await types(other)).toEqual([]);
    expect((await inbox(x.director))[0]!.payload).toMatchObject({
      missionName: 'Artemis Relay',
      startDate: '2027-03-01',
      endDate: '2027-03-10',
    });
  });

  it('Approved: the owning Lead, and each assigned Crew Member as "assigned"; nobody else', async () => {
    const { x, director2 } = await cast('Notify approve');
    const m = await x.crewing({
      crew: [x.ann.userId],
      requirements: [{ skillId: x.medicine.id, minLevel: 3, count: 1 }],
    });
    const pending = await x.act(m, 'submit');
    await x.act(pending, 'approve', x.director, 'Good luck');
    expect(await types(x.lead)).toEqual(['mission.approved']);
    expect((await inbox(x.lead))[0]!.payload).toMatchObject({
      missionId: m.id,
      comment: 'Good luck',
    });
    expect(await types(x.ann)).toEqual(['mission.assigned']);
    expect((await inbox(x.ann))[0]!.payload).toEqual({
      missionId: m.id,
      missionName: 'Artemis Relay',
      startDate: '2027-03-01',
      endDate: '2027-03-10',
    });
    for (const other of [x.lead2, x.bob]) expect(await types(other)).toEqual([]);
    // Directors had the earlier submission notice and nothing for the approval.
    expect(await types(director2)).toEqual(['mission.submitted']);
  });

  it('Approved without a comment carries none', async () => {
    const x = await missionWorld(h, 'Notify approve silent');
    await x.approved();
    expect((await inbox(x.lead))[0]!.payload).not.toHaveProperty('comment');
  });

  it('Rejected: the owning Lead only, with the reason', async () => {
    const { x } = await cast('Notify reject');
    const m = await x.pending();
    await x.act(m, 'reject', x.director, 'Not this quarter');
    expect(await types(x.lead)).toEqual(['mission.rejected']);
    expect((await inbox(x.lead))[0]!.payload).toMatchObject({
      missionId: m.id,
      reason: 'Not this quarter',
    });
    for (const other of [x.lead2, x.ann, x.bob]) expect(await types(other)).toEqual([]);
  });

  it('Cancelled after approval: the assigned Crew only; not the owner, not other Crew', async () => {
    const { x } = await cast('Notify cancel');
    const m = await x.approved();
    const leadBefore = (await inbox(x.lead)).length;
    await x.act(m, 'cancel');
    expect(await types(x.ann)).toEqual(['mission.cancelled', 'mission.assigned']);
    expect((await inbox(x.ann))[0]!.payload).toMatchObject({ missionId: m.id });
    expect((await inbox(x.lead)).length).toBe(leadBefore);
    expect(await types(x.bob)).toEqual([]);
  });

  it('sends nothing for the other transitions: start crewing, reopen, withdraw, cancel before approval', async () => {
    const { x } = await cast('Notify quiet');
    const m = await x.crewing({ crew: [x.ann.userId] });
    const reopened = await x.act(m, 'reopen');
    const crewing = await x.act(reopened, 'start_crewing');
    const pending = await x.act(
      await h.missions.replaceCrew(x.lead.actor, crewing.id, [x.ann.userId], {
        version: crewing.version,
      }),
      'submit',
    );
    const directorsBefore = (await inbox(x.director)).length;
    const withdrawn = await x.act(pending, 'withdraw');
    await x.act(withdrawn, 'cancel');
    const cancelledDraft = await x.act(await x.draft(), 'cancel');
    void cancelledDraft;
    expect(await types(x.lead)).toEqual([]);
    expect(await types(x.ann)).toEqual([]);
    expect((await inbox(x.director)).length).toBe(directorsBefore);
  });

  it('is written in the transaction of the change: a failed transition sends nothing', async () => {
    const { x } = await cast('Notify atomic');
    const m = await x.crewing(); // empty crew: submit fails
    await expect(x.act(m, 'submit')).rejects.toMatchObject({ code: 'MISSION_CREW_EMPTY' });
    expect(await types(x.director)).toEqual([]);
  });
});

describe('the inbox', () => {
  it("lists the caller's notifications newest first, filters unread, and pages", async () => {
    const x = await missionWorld(h, 'Inbox');
    for (let i = 0; i < 3; i++)
      await x.pending({ startDate: `2027-0${i + 3}-01`, endDate: `2027-0${i + 3}-05` });
    const all = await h.notifications.list(x.director.actor, { limit: 100 });
    expect(all.items).toHaveLength(3);
    expect(all.items.map((n) => n.id)).toEqual([...all.items.map((n) => n.id)].sort().reverse());
    expect(all.items.every((n) => n.readAt === null)).toBe(true);

    const read = await h.notifications.markRead(x.director.actor, all.items[0]!.id);
    expect(read.readAt).not.toBeNull();
    expect(
      (await h.notifications.list(x.director.actor, { limit: 100, unread: true })).items.map(
        (n) => n.id,
      ),
    ).toEqual(all.items.slice(1).map((n) => n.id));
    expect(
      (await h.notifications.list(x.director.actor, { limit: 100, unread: false })).items,
    ).toHaveLength(3);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await h.notifications.list(x.director.actor, { limit: 1, cursor });
      seen.push(...page.items.map((n) => n.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all.items.map((n) => n.id));
    await expect(
      h.notifications.list(x.director.actor, { limit: 5, cursor: 'garbage' }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('marks as read once, and idempotently', async () => {
    const x = await missionWorld(h, 'Inbox read');
    await x.pending();
    const [n] = await inbox(x.director);
    const first = await h.notifications.markRead(x.director.actor, n!.id);
    h.clock.advance(60_000);
    const second = await h.notifications.markRead(x.director.actor, n!.id);
    expect(second.readAt).toBe(first.readAt);
  });

  it("is private: nobody can read or mark another person's notification, and other organisations see nothing", async () => {
    const x = await missionWorld(h, 'Inbox private');
    const other = await missionWorld(h, 'Inbox private other');
    await x.pending();
    const [n] = await inbox(x.director);
    for (const who of [x.lead, x.ann, other.director]) {
      await expect(h.notifications.markRead(who.actor, n!.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    }
    await expect(h.notifications.markRead(x.director.actor, newId())).rejects.toMatchObject({
      status: 404,
    });
    expect(await inbox(other.director)).toEqual([]);
    expect((await inbox(x.director))[0]!.readAt).toBeNull();
  });

  it('is available to every role', async () => {
    const x = await missionWorld(h, 'Inbox roles');
    await x.approved();
    for (const who of [x.director, x.lead, x.ann]) {
      await expect(h.notifications.list(who.actor, { limit: 5 })).resolves.toBeDefined();
    }
    await expect(h.notifications.list({ kind: 'system' }, { limit: 5 })).rejects.toMatchObject({
      status: 403,
    });
  });
});

void ({} as MissionWorld);
