import type { Mission, MissionAction } from '@mc/contracts';
import { onboardUser, provisionOrganisation, type Harness } from './harness.js';

/** An organisation ready for mission tests: a Director, two Leads, two Crew Members and two skills. */
export async function missionWorld(h: Harness, label = 'Missions') {
  const org = await provisionOrganisation(h, label);
  const lead = await onboardUser(h, org, 'lead', 'lead');
  const lead2 = await onboardUser(h, org, 'lead', 'lead2');
  const ann = await onboardUser(h, org, 'crew', 'ann');
  const bob = await onboardUser(h, org, 'crew', 'bob');
  const medicine = await h.skills.create(org.director.actor, { name: 'Medicine' });
  const piloting = await h.skills.create(org.director.actor, { name: 'Piloting' });
  await h.crew.setSkill(ann.actor, medicine.id, 4);
  await h.crew.setSkill(ann.actor, piloting.id, 5);
  await h.crew.setSkill(bob.actor, medicine.id, 2);

  const world = { org, director: org.director, lead, lead2, ann, bob, medicine, piloting };

  /** A new Draft mission owned by `owner` (default: the first Lead). */
  const draft = (
    input: Partial<{ name: string; startDate: string; endDate: string; description: string }> = {},
    owner = lead,
  ) =>
    h.missions.create(owner.actor, {
      name: input.name ?? 'Artemis Relay',
      description: input.description ?? '',
      startDate: input.startDate ?? '2027-03-01',
      endDate: input.endDate ?? '2027-03-10',
    });

  const act = (
    m: Pick<Mission, 'id' | 'version'>,
    action: MissionAction,
    who = lead,
    comment?: string,
  ) => h.missions.transition(who.actor, m.id, { action, comment }, m.version);

  /** A mission in Crewing with the given requirements and crew. */
  const crewing = async (
    options: {
      requirements?: Array<{ skillId: string; minLevel: number; count: number }>;
      crew?: string[];
      owner?: typeof lead;
    } & Partial<{ name: string; startDate: string; endDate: string }> = {},
  ) => {
    const owner = options.owner ?? lead;
    let m: Mission = await draft(options, owner);
    m = await h.missions.setRequirements(
      owner.actor,
      m.id,
      { requirements: options.requirements ?? [{ skillId: medicine.id, minLevel: 3, count: 1 }] },
      m.version,
    );
    m = await act(m, 'start_crewing', owner);
    if (options.crew)
      m = await h.missions.replaceCrew(owner.actor, m.id, options.crew, { version: m.version });
    return m;
  };

  /** A mission in Pending approval (Ann is the crew). */
  const pending = async (options: Parameters<typeof crewing>[0] = {}) => {
    const owner = options.owner ?? lead;
    const m = await crewing({ crew: [ann.userId], ...options });
    return act(m, 'submit', owner);
  };

  const approved = async (options: Parameters<typeof crewing>[0] = {}) =>
    act(await pending(options), 'approve', world.director);

  return { ...world, draft, act, crewing, pending, approved };
}
export type MissionWorld = Awaited<ReturnType<typeof missionWorld>>;
