import type { Actor, Mission, MissionAction, SeedResponse } from '@mc/contracts';
import type { Db } from '@mc/db';
import type { Solver } from '@mc/matcher';
import type { AccessTokenService } from '../auth/access-tokens.js';
import { DbAuditWriter } from '../audit/db-audit-writer.js';
import type { Clock } from '../clock.js';
import { todayIn } from '../dates.js';
import type { Logger } from '../logger.js';
import { createServices } from '../services.js';

export const DEMO_PASSWORD = 'demo-password-123';
const DAY_MS = 24 * 60 * 60 * 1000;

type Role = 'director' | 'lead' | 'crew';
type Outcome =
  | 'draft'
  | 'cancelled'
  | 'crewing'
  | 'rejected_once'
  | 'pending_approval'
  | 'approved'
  | 'active'
  | 'completed';

interface PersonSpec {
  key: string;
  name: string;
  role: Role;
  /** Skill name → level; crew only. */
  skills?: Record<string, number>;
}

interface MissionSpec {
  name: string;
  description: string;
  lead: string;
  /** Days from today; negative is in the past. */
  start: number;
  end: number;
  requirements?: Array<[skill: string, minLevel: number, count: number]>;
  crew?: string[];
  outcome: Outcome;
  acknowledgedBy?: string[];
}

interface OrganisationSpec {
  name: string;
  domain: string;
  timeZone: string;
  skills: string[];
  people: PersonSpec[];
  unavailable?: Array<{ person: string; from: number; to: number; note: string }>;
  missions: MissionSpec[];
}

/**
 * Two organisations with Directors, Leads, crew, skills and missions in every state. Dates are
 * relative to the day the seed runs. Crew are never booked on overlapping missions, and none is
 * above the default workload cap of three.
 */
export const DEMO_SCENARIO: readonly OrganisationSpec[] = [
  {
    name: 'Lunar Gateway Operations',
    domain: 'lunar-gateway.example',
    timeZone: 'Europe/London',
    skills: ['Piloting', 'Medicine', 'Geology', 'Engineering', 'Communications'],
    people: [
      { key: 'director', name: 'Grace Hopper', role: 'director' },
      { key: 'second-director', name: 'Katherine Johnson', role: 'director' },
      { key: 'lead-ada', name: 'Ada Lovelace', role: 'lead' },
      { key: 'lead-sally', name: 'Sally Ride', role: 'lead' },
      { key: 'ann', name: 'Ann Aldrin', role: 'crew', skills: { Piloting: 5, Engineering: 3 } },
      { key: 'bob', name: 'Bob Collins', role: 'crew', skills: { Medicine: 4, Communications: 2 } },
      { key: 'cy', name: 'Cy Young', role: 'crew', skills: { Geology: 4, Engineering: 4 } },
      { key: 'dee', name: 'Dee Shepard', role: 'crew', skills: { Medicine: 2, Piloting: 3 } },
      { key: 'eli', name: 'Eli Whitson', role: 'crew', skills: { Communications: 5, Geology: 2 } },
    ],
    unavailable: [{ person: 'dee', from: 15, to: 19, note: 'Training course' }],
    missions: [
      {
        name: 'Gateway Resupply Run',
        description: 'Deliver supplies to the Gateway and return.',
        lead: 'lead-ada',
        start: -12,
        end: -8,
        requirements: [
          ['Piloting', 4, 1],
          ['Medicine', 3, 1],
        ],
        crew: ['ann', 'bob'],
        outcome: 'completed',
        acknowledgedBy: ['ann', 'bob'],
      },
      {
        name: 'Surface Survey Alpha',
        description: 'Geological survey of the landing site.',
        lead: 'lead-ada',
        start: -3,
        end: 6,
        requirements: [
          ['Geology', 3, 1],
          ['Communications', 3, 1],
        ],
        crew: ['cy', 'eli'],
        outcome: 'active',
        acknowledgedBy: ['cy', 'eli'],
      },
      {
        name: 'Orbital Relay Install',
        description: 'Install the second communications relay.',
        lead: 'lead-ada',
        start: 10,
        end: 14,
        requirements: [['Engineering', 3, 2]],
        crew: ['ann', 'cy'],
        outcome: 'approved',
        acknowledgedBy: ['ann'],
      },
      {
        name: 'Medical Rotation',
        description: 'Crew health checks aboard the Gateway.',
        lead: 'lead-sally',
        start: 20,
        end: 25,
        requirements: [['Medicine', 3, 1]],
        crew: ['bob'],
        outcome: 'pending_approval',
      },
      {
        name: 'Deep Field Prospecting',
        description:
          'Prospecting beyond the survey area. Rejected once: the crew needs a second look.',
        lead: 'lead-sally',
        start: 30,
        end: 40,
        requirements: [
          ['Geology', 3, 1],
          ['Piloting', 3, 1],
        ],
        crew: ['cy', 'dee'],
        outcome: 'rejected_once',
      },
      {
        name: 'Comms Array Calibration',
        description: 'Calibrate the surface comms array.',
        lead: 'lead-sally',
        start: 45,
        end: 47,
        outcome: 'draft',
      },
      {
        name: 'Cancelled Test Flight',
        description: 'Superseded by the resupply run.',
        lead: 'lead-ada',
        start: 50,
        end: 51,
        outcome: 'cancelled',
      },
    ],
  },
  {
    name: 'Mars Transit Authority',
    domain: 'mars-transit.example',
    timeZone: 'America/Los_Angeles',
    skills: ['Navigation', 'Life Support', 'Robotics'],
    people: [
      { key: 'director', name: 'Valentina Tereshkova', role: 'director' },
      { key: 'lead', name: 'Mae Jemison', role: 'lead' },
      { key: 'fay', name: 'Fay Armstrong', role: 'crew', skills: { Navigation: 4, Robotics: 2 } },
      { key: 'gus', name: 'Gus Grissom', role: 'crew', skills: { 'Life Support': 5 } },
      { key: 'hal', name: 'Hal Glenn', role: 'crew', skills: { Robotics: 4, Navigation: 3 } },
    ],
    missions: [
      {
        name: 'Phobos Approach',
        description: 'Navigate the transit vehicle to a Phobos rendezvous.',
        lead: 'lead',
        start: -2,
        end: 8,
        requirements: [
          ['Navigation', 4, 1],
          ['Life Support', 4, 1],
        ],
        crew: ['fay', 'gus'],
        outcome: 'active',
        acknowledgedBy: ['fay', 'gus'],
      },
      {
        name: 'Habitat Assembly',
        description: 'Robotic assembly of the surface habitat.',
        lead: 'lead',
        start: 14,
        end: 24,
        requirements: [['Robotics', 3, 1]],
        crew: ['hal'],
        outcome: 'approved',
      },
      {
        name: 'Orbit Insertion Rehearsal',
        description: 'Simulation of the orbit insertion burn.',
        lead: 'lead',
        start: 30,
        end: 32,
        requirements: [['Navigation', 3, 1]],
        crew: ['fay'],
        outcome: 'pending_approval',
      },
      {
        name: 'Greenhouse Trial',
        description: 'First crop cycle aboard the transit vehicle.',
        lead: 'lead',
        start: 40,
        end: 60,
        outcome: 'draft',
      },
    ],
  },
];

/** A clock the seed moves through time, so history gets realistic audit and release times. */
class SeedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  set(to: Date): void {
    this.current = to;
  }
}

export interface SeedConfig {
  db: Db;
  accessTokens: AccessTokenService;
  solver: Solver;
  logger: Logger;
  /** The real current time; the scenario is laid out relative to it. */
  now: Date;
}

const isoDay = (now: Date, offsetDays: number): string =>
  new Date(now.getTime() + offsetDays * DAY_MS).toISOString().slice(0, 10);

/**
 * Seeds the demo scenario through the same services the API uses, moving a private clock back in
 * time to give Completed and Active missions a believable history. Every person gets
 * {@link DEMO_PASSWORD}. Fails with `EMAIL_ALREADY_REGISTERED` if it was seeded before.
 */
export async function seedDemo(config: SeedConfig): Promise<SeedResponse> {
  const clock = new SeedClock(new Date(config.now.getTime() - 14 * DAY_MS));
  const services = createServices({
    db: config.db,
    audit: new DbAuditWriter(clock),
    clock,
    logger: config.logger,
    accessTokens: config.accessTokens,
    solver: config.solver,
  });
  const { platform, auth, users, settings, skills, crew, missions, assignments } = services;

  interface Built {
    spec: OrganisationSpec;
    orgId: string;
    people: Map<string, { actor: Actor; userId: string; email: string }>;
    skillIds: Map<string, string>;
    built: Array<{ spec: MissionSpec; mission: Mission }>;
  }

  const onboard = async (spec: OrganisationSpec): Promise<Built> => {
    const directorSpec = spec.people.find((p) => p.key === 'director')!;
    const emailOf = (key: string) => `${key}@${spec.domain}`;
    const created = await platform.createOrganisation({
      name: spec.name,
      directorEmail: emailOf('director'),
    });
    await auth.acceptInvite({
      code: created.invite.inviteCode,
      name: directorSpec.name,
      password: DEMO_PASSWORD,
    });
    const people: Built['people'] = new Map();
    const actorOf = (userId: string, role: Role): Actor => ({
      kind: 'user',
      userId,
      orgId: created.organisationId,
      role,
    });
    const director = actorOf(created.directorUserId, 'director');
    people.set('director', {
      actor: director,
      userId: created.directorUserId,
      email: emailOf('director'),
    });

    await settings.update(director, { timeZone: spec.timeZone });
    const skillIds = new Map<string, string>();
    for (const name of spec.skills)
      skillIds.set(name, (await skills.create(director, { name })).id);

    for (const person of spec.people.filter((p) => p.key !== 'director')) {
      const invited = await users.invite(director, {
        email: emailOf(person.key),
        role: person.role,
      });
      await auth.acceptInvite({
        code: invited.invite.inviteCode,
        name: person.name,
        password: DEMO_PASSWORD,
      });
      const actor = actorOf(invited.user.id, person.role);
      people.set(person.key, { actor, userId: invited.user.id, email: emailOf(person.key) });
      for (const [skill, level] of Object.entries(person.skills ?? {})) {
        await crew.setSkill(actor, skillIds.get(skill)!, level);
      }
    }
    return { spec, orgId: created.organisationId, people, skillIds, built: [] };
  };

  const buildMission = async (org: Built, spec: MissionSpec): Promise<Mission> => {
    const person = (key: string) => org.people.get(key)!;
    const lead = person(spec.lead).actor;
    const director = person('director').actor;
    const act = (m: Mission, action: MissionAction, actor: Actor, comment?: string) =>
      missions.transition(actor, m.id, { action, comment }, m.version);

    let m = await missions.create(lead, {
      name: spec.name,
      description: spec.description,
      startDate: isoDay(config.now, spec.start),
      endDate: isoDay(config.now, spec.end),
    });
    if (spec.requirements) {
      m = await missions.setRequirements(
        lead,
        m.id,
        {
          requirements: spec.requirements.map(([skill, minLevel, count]) => ({
            skillId: org.skillIds.get(skill)!,
            minLevel,
            count,
          })),
        },
        m.version,
      );
    }
    if (spec.outcome === 'draft') return m;
    if (spec.outcome === 'cancelled') return act(m, 'cancel', lead);

    m = await act(m, 'start_crewing', lead);
    if (spec.crew) {
      m = await missions.replaceCrew(
        lead,
        m.id,
        spec.crew.map((key) => person(key).userId),
        { version: m.version },
      );
    }
    if (spec.outcome === 'crewing') return m;

    m = await act(m, 'submit', lead);
    if (spec.outcome === 'pending_approval') return m;
    if (spec.outcome === 'rejected_once') {
      return act(m, 'reject', director, 'Please confirm the second pilot before resubmitting.');
    }

    m = await act(m, 'approve', director, 'Approved for the programme.');
    for (const key of spec.acknowledgedBy ?? []) {
      const assignment = m.crew.find((c) => c.crewMemberId === person(key).userId);
      if (assignment) await assignments.acknowledge(person(key).actor, assignment.assignmentId);
    }
    return m;
  };

  const orgs: Built[] = [];
  for (const spec of DEMO_SCENARIO) orgs.push(await onboard(spec));

  // Phase 1, two weeks ago: the missions that have since started or finished get approved.
  const history = (outcome: Outcome) => outcome === 'active' || outcome === 'completed';
  for (const org of orgs) {
    for (const spec of org.spec.missions.filter((s) => history(s.outcome))) {
      org.built.push({ spec, mission: await buildMission(org, spec) });
    }
  }
  // Phase 2, two days ago: the scheduler would have started them and completed the old ones.
  clock.set(new Date(config.now.getTime() - 2 * DAY_MS));
  for (const org of orgs) {
    await config.db.withTenant(org.orgId, (tx) =>
      missions.runSystemTransitions(tx, todayIn(clock.now(), org.spec.timeZone)),
    );
  }
  // Phase 3, now: everything still in flight.
  clock.set(config.now);
  for (const org of orgs) {
    for (const spec of org.spec.missions.filter((s) => !history(s.outcome))) {
      org.built.push({ spec, mission: await buildMission(org, spec) });
    }
    for (const u of org.spec.unavailable ?? []) {
      await crew.addUnavailability(org.people.get(u.person)!.actor, {
        from: isoDay(config.now, u.from),
        to: isoDay(config.now, u.to),
        note: u.note,
      });
    }
  }

  const organisations: SeedResponse['organisations'] = [];
  for (const org of orgs) {
    const reader = org.people.get('director')!.actor;
    organisations.push({
      id: org.orgId,
      name: org.spec.name,
      timeZone: org.spec.timeZone,
      users: org.spec.people.map((p) => ({
        role: p.role,
        name: p.name,
        email: org.people.get(p.key)!.email,
      })),
      missions: await Promise.all(
        org.built.map(async ({ spec, mission }) => ({
          name: spec.name,
          status: (await missions.get(reader, mission.id)).status,
        })),
      ),
    });
  }
  return { scenario: 'demo', password: DEMO_PASSWORD, organisations };
}
