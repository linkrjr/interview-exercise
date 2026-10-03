import type {
  Alert,
  Assignment,
  AuditEvent,
  CrewProfile,
  Invite,
  InviteUserRequest,
  InviteUserResponse,
  Mission,
  MissionSummary,
  Notification,
  OrgSettings,
  Page,
  Skill,
  UpdateOrgSettingsRequest,
  User,
} from '@mc/contracts';
import type { AlertsApi } from './alerts-api.js';
import type { Apis } from './apis.js';
import type { AssignmentsApi } from './assignments-api.js';
import type { AuditApi } from './audit-api.js';
import type { CrewApi } from './crew-api.js';
import type { InboxApi } from './inbox-api.js';
import type { Decision, ListMissionsQuery, MissionsApi } from './missions-api.js';
import type { ProfileApi } from './profile-api.js';
import type { SettingsApi } from './settings-api.js';
import type { SkillsApi } from './skills-api.js';
import type { UsersApi } from './users-api.js';

const uuid = (n: number) => `0199aaaa-bbbb-7ccc-8ddd-${String(n).padStart(12, '0')}`;

export const summary = (n: number, over: Partial<MissionSummary> = {}): MissionSummary => ({
  id: uuid(n),
  name: `Mission ${String(n).padStart(2, '0')}`,
  description: '',
  startDate: '2027-03-01',
  endDate: '2027-03-10',
  status: 'pending_approval',
  version: 3,
  leadId: uuid(900),
  leadName: 'Lee Lead',
  createdAt: '2026-10-02T10:00:00.000Z',
  ...over,
});

export const mission = (over: Partial<Mission> = {}): Mission => ({
  ...summary(1),
  description: 'Relay station for the far side.',
  status: 'crewing',
  requirements: [
    { skillId: uuid(70), skillName: 'Orbital Piloting', minLevel: 4, count: 1 },
    { skillId: uuid(71), skillName: 'Medicine', minLevel: 3, count: 2 },
  ],
  crew: [
    {
      assignmentId: uuid(80),
      crewMemberId: uuid(81),
      name: 'Ann Crew',
      email: 'ann@example.com',
      acknowledgedAt: null,
    },
    {
      assignmentId: uuid(82),
      crewMemberId: uuid(83),
      name: null,
      email: 'bob@example.com',
      acknowledgedAt: '2026-10-03T08:00:00.000Z',
    },
  ],
  decisions: [
    {
      id: uuid(90),
      directorId: uuid(91),
      decision: 'rejected',
      comment: 'Confirm the second pilot',
      decidedAt: '2026-10-03T09:00:00.000Z',
    },
  ],
  crewValidation: {
    valid: false,
    assignmentIssues: [{ assignmentId: uuid(80), crewMemberId: uuid(81), code: 'NOT_ELIGIBLE' }],
    unmetRequirements: [{ skillId: uuid(71), minLevel: 3, required: 2, met: 1 }],
  },
  allowedActions: [],
  ...over,
});

export interface FakeApi extends MissionsApi {
  listCalls: ListMissionsQuery[];
  getCalls: string[];
  decideCalls: Array<{ id: string } & Decision>;
  /** Every other change, in order: `{ call: 'transition', id, args }` and so on. */
  changeCalls: Array<{ call: string; id?: string; args: unknown[] }>;
}

/** A MissionsApi over fixed pages; `pages[i]` is returned for the i-th call, the last one repeating. */
export function fakeApi(
  pages: Array<Page<MissionSummary> | Error>,
  detail: Mission | Error | (() => Promise<Mission>) = mission(),
  /** What deciding returns: the updated mission, or the error to throw. */
  decided: Mission | Error | ((d: Decision) => Mission) = mission({
    status: 'approved',
    allowedActions: [],
  }),
  /** What create, update, transition, setRequirements and setCrew return (or throw). */
  changes: Mission | Error | ((call: string) => Mission) = mission({ version: 4 }),
): FakeApi {
  const listCalls: ListMissionsQuery[] = [];
  const getCalls: string[] = [];
  const decideCalls: Array<{ id: string } & Decision> = [];
  const changeCalls: Array<{ call: string; id?: string; args: unknown[] }> = [];
  /** What a change returns: the `changed` mission (default: the detail as it was), or its error. */
  const changed = async (call: string, id: string | undefined, ...args: unknown[]) => {
    changeCalls.push({ call, id, args });
    if (changes instanceof Error) throw changes;
    return typeof changes === 'function' ? changes(call) : changes;
  };
  return {
    listCalls,
    getCalls,
    decideCalls,
    changeCalls,
    create: (input) => changed('create', undefined, input),
    update: (id, input, version) => changed('update', id, input, version),
    transition: (id, action, version) => changed('transition', id, action, version),
    setRequirements: (id, reqs, version) => changed('setRequirements', id, reqs, version),
    setCrew: (id, ids, version) => changed('setCrew', id, ids, version),
    async list(query = {}) {
      const page = pages[Math.min(listCalls.length, pages.length - 1)]!;
      listCalls.push(query);
      if (page instanceof Error) throw page;
      return page;
    },
    async get(id) {
      getCalls.push(id);
      if (typeof detail === 'function') return detail();
      if (detail instanceof Error) throw detail;
      return detail;
    },
    async decide(id, decision) {
      decideCalls.push({ id, ...decision });
      if (decided instanceof Error) throw decided;
      return typeof decided === 'function' ? decided(decision) : decided;
    },
  };
}

export const pageOf = (items: MissionSummary[], nextCursor: string | null = null) => ({
  items,
  nextCursor,
});

export const manyMissions = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => summary(from + i));

export const user = (n: number, over: Partial<User> = {}): User => ({
  id: uuid(500 + n),
  email: `user${n}@example.com`,
  name: `User ${String(n).padStart(2, '0')}`,
  role: 'crew',
  status: 'active',
  createdAt: '2026-09-01T10:00:00.000Z',
  ...over,
});

export interface FakeUsersApi extends UsersApi {
  listCalls: Array<{ cursor?: string; limit?: number }>;
  inviteCalls: InviteUserRequest[];
  deactivateCalls: string[];
  reinviteCalls: string[];
}

/** A UsersApi over fixed pages; `results` decides what invite, deactivate and reinvite answer. */
export function fakeUsersApi(
  pages: Array<Page<User> | Error> = [{ items: [], nextCursor: null }],
  results: {
    invite?: InviteUserResponse | Error;
    deactivate?: User | Error;
    reinvite?: Invite | Error;
  } = {},
): FakeUsersApi {
  const calls: FakeUsersApi = {
    listCalls: [],
    inviteCalls: [],
    deactivateCalls: [],
    reinviteCalls: [],
    async list(query = {}) {
      const page = pages[Math.min(calls.listCalls.length, pages.length - 1)]!;
      calls.listCalls.push(query);
      if (page instanceof Error) throw page;
      return page;
    },
    async invite(input) {
      calls.inviteCalls.push(input);
      const result = results.invite ?? {
        user: user(99, { email: input.email, role: input.role, name: null, status: 'invited' }),
        invite: { inviteCode: 'ORG.secret-code', expiresAt: '2026-10-10T10:00:00.000Z' },
      };
      if (result instanceof Error) throw result;
      return result;
    },
    async deactivate(id) {
      calls.deactivateCalls.push(id);
      const result = results.deactivate ?? user(1, { status: 'deactivated' });
      if (result instanceof Error) throw result;
      return result;
    },
    async reinvite(id) {
      calls.reinviteCalls.push(id);
      const result = results.reinvite ?? {
        inviteCode: 'ORG.new-secret',
        expiresAt: '2026-10-11T10:00:00.000Z',
      };
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return calls;
}

export const skill = (n: number, over: Partial<Skill> = {}): Skill => ({
  id: uuid(700 + n),
  name: `Skill ${String(n).padStart(2, '0')}`,
  createdAt: '2026-09-02T10:00:00.000Z',
  ...over,
});

export interface FakeSkillsApi extends SkillsApi {
  listCalls: Array<{ cursor?: string; limit?: number }>;
  createCalls: string[];
  renameCalls: Array<{ id: string; name: string }>;
}

/** A SkillsApi over fixed pages; `results` decides what create and rename answer. */
export function fakeSkillsApi(
  pages: Array<Page<Skill> | Error> = [{ items: [], nextCursor: null }],
  results: { create?: Skill | Error; rename?: Skill | Error } = {},
): FakeSkillsApi {
  const calls: FakeSkillsApi = {
    listCalls: [],
    createCalls: [],
    renameCalls: [],
    async list(query = {}) {
      const page = pages[Math.min(calls.listCalls.length, pages.length - 1)]!;
      calls.listCalls.push(query);
      if (page instanceof Error) throw page;
      return page;
    },
    async create(name) {
      calls.createCalls.push(name);
      const result = results.create ?? skill(99, { name });
      if (result instanceof Error) throw result;
      return result;
    },
    async rename(id, name) {
      calls.renameCalls.push({ id, name });
      const result = results.rename ?? skill(1, { id, name });
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return calls;
}

export interface FakeSettingsApi extends SettingsApi {
  getCalls: number;
  updateCalls: UpdateOrgSettingsRequest[];
}

/** A SettingsApi: `get` answers `initial`; `update` applies the patch to it unless told to fail. */
export function fakeSettingsApi(
  initial: OrgSettings | Error = { timeZone: 'Europe/London', maxUpcomingMissions: 3 },
  updateFails?: Error,
): FakeSettingsApi {
  let current = initial;
  const calls: FakeSettingsApi = {
    getCalls: 0,
    updateCalls: [],
    async get() {
      calls.getCalls++;
      if (current instanceof Error) throw current;
      return current;
    },
    async update(patch) {
      calls.updateCalls.push(patch);
      if (updateFails) throw updateFails;
      if (current instanceof Error) throw current;
      current = { ...current, ...patch };
      return current;
    },
  };
  return calls;
}

// ------------------------------------------------------------------ audit, alerts, inbox, assignments

export const auditEvent = (n: number, over: Partial<AuditEvent> = {}): AuditEvent => ({
  id: uuid(800 + n),
  action: 'mission.approve',
  entityType: 'mission',
  entityId: uuid(1),
  actorId: uuid(501),
  before: { status: 'pending_approval', version: 4 },
  after: { status: 'approved', version: 5, comment: 'Go' },
  occurredAt: `2026-10-03T14:07:${String(n % 60).padStart(2, '0')}.123Z`,
  ...over,
});

export const alert = (n: number, over: Partial<Alert> = {}): Alert => ({
  id: uuid(900 + n),
  source: 'scheduler',
  code: 'SCHEDULER_RUN_FAILED',
  message: 'The scheduler could not process this organisation.',
  details: { stage: 'transitions', today: '2026-10-03', error: { name: 'Error', code: '53100' } },
  occurredAt: `2026-10-03T03:00:${String(n % 60).padStart(2, '0')}.000Z`,
  ...over,
});

export const notification = (n: number, over: Partial<Notification> = {}): Notification => ({
  id: uuid(1000 + n),
  type: 'mission.approved',
  payload: { missionId: uuid(1), missionName: 'Artemis Relay', comment: 'Go for it' },
  readAt: null,
  createdAt: `2026-10-03T09:00:${String(n % 60).padStart(2, '0')}.000Z`,
  ...over,
});

export const assignment = (n: number, over: Partial<Assignment> = {}): Assignment => ({
  id: uuid(1100 + n),
  acknowledgedAt: null,
  mission: {
    id: uuid(n),
    name: `Mission ${String(n).padStart(2, '0')}`,
    description: 'Relay station for the far side.',
    startDate: '2027-03-01',
    endDate: '2027-03-10',
    status: 'approved',
  },
  ...over,
});

const pagedFake = <T>(pages: Array<Page<T> | Error>) => {
  const listCalls: Array<{ cursor?: string; limit?: number }> = [];
  return {
    listCalls,
    async list(query: { cursor?: string; limit?: number } = {}): Promise<Page<T>> {
      const page = pages[Math.min(listCalls.length, pages.length - 1)]!;
      listCalls.push(query);
      if (page instanceof Error) throw page;
      return page;
    },
  };
};

export const onePage = <T>(items: T[], nextCursor: string | null = null): Page<T> => ({
  items,
  nextCursor,
});

export interface FakeAuditApi extends AuditApi {
  listCalls: Array<{ cursor?: string; limit?: number }>;
}
export const fakeAuditApi = (
  pages: Array<Page<AuditEvent> | Error> = [onePage([])],
): FakeAuditApi => pagedFake(pages);

export interface FakeAlertsApi extends AlertsApi {
  listCalls: Array<{ cursor?: string; limit?: number }>;
}
export const fakeAlertsApi = (pages: Array<Page<Alert> | Error> = [onePage([])]): FakeAlertsApi =>
  pagedFake(pages);

export interface FakeCrewApi extends CrewApi {
  listCalls: Array<{ cursor?: string; limit?: number }>;
}
export const fakeCrewApi = (pages: Array<Page<CrewProfile> | Error> = [onePage([])]): FakeCrewApi =>
  pagedFake(pages);

export interface FakeInboxApi extends InboxApi {
  listCalls: Array<{ cursor?: string; limit?: number }>;
  markReadCalls: string[];
}
export function fakeInboxApi(
  pages: Array<Page<Notification> | Error> = [onePage([])],
  markRead?: Notification | Error,
): FakeInboxApi {
  const calls: FakeInboxApi = {
    ...pagedFake(pages),
    markReadCalls: [],
    async markRead(id) {
      calls.markReadCalls.push(id);
      if (markRead instanceof Error) throw markRead;
      return markRead ?? notification(1, { id, readAt: '2026-10-03T15:00:00.000Z' });
    },
  };
  return calls;
}

export interface FakeAssignmentsApi extends AssignmentsApi {
  listCalls: Array<{ cursor?: string; limit?: number }>;
  acknowledgeCalls: string[];
}
export function fakeAssignmentsApi(
  pages: Array<Page<Assignment> | Error> = [onePage([])],
  acknowledge?: Assignment | Error,
): FakeAssignmentsApi {
  const calls: FakeAssignmentsApi = {
    ...pagedFake(pages),
    acknowledgeCalls: [],
    async acknowledge(id) {
      calls.acknowledgeCalls.push(id);
      if (acknowledge instanceof Error) throw acknowledge;
      return acknowledge ?? assignment(1, { id, acknowledgedAt: '2026-10-03T15:00:00.000Z' });
    },
  };
  return calls;
}

export const crewProfile = (n: number, over: Partial<CrewProfile> = {}): CrewProfile => ({
  id: uuid(1200 + n),
  name: `Crew ${String(n).padStart(2, '0')}`,
  email: `crew${n}@example.com`,
  skills: [],
  unavailability: [],
  load: 0,
  ...over,
});

export interface FakeProfileApi extends ProfileApi {
  getCalls: string[];
  setSkillCalls: Array<{ skillId: string; level: number }>;
  removeSkillCalls: string[];
  addCalls: Array<{ from: string; to: string; note?: string }>;
  removeCalls: string[];
}

/** A ProfileApi over a profile it keeps up to date as skills and ranges change, unless told to fail. */
export function fakeProfileApi(
  initial: CrewProfile | Error = crewProfile(1),
  fail?: Error,
): FakeProfileApi {
  let profile = initial;
  const calls: FakeProfileApi = {
    getCalls: [],
    setSkillCalls: [],
    removeSkillCalls: [],
    addCalls: [],
    removeCalls: [],
    async get(userId) {
      calls.getCalls.push(userId);
      if (profile instanceof Error) throw profile;
      return profile;
    },
    async setSkill(skillId, level) {
      calls.setSkillCalls.push({ skillId, level });
      if (fail) throw fail;
      if (profile instanceof Error) throw profile;
      const name =
        profile.skills.find((s) => s.skillId === skillId)?.name ?? `Skill ${skillId.slice(-3)}`;
      const entry = { skillId, name, level };
      profile = {
        ...profile,
        skills: [...profile.skills.filter((s) => s.skillId !== skillId), entry],
      };
      return entry;
    },
    async removeSkill(skillId) {
      calls.removeSkillCalls.push(skillId);
      if (fail) throw fail;
      if (profile instanceof Error) throw profile;
      profile = { ...profile, skills: profile.skills.filter((s) => s.skillId !== skillId) };
    },
    async addUnavailability(range) {
      calls.addCalls.push(range);
      if (fail) throw fail;
      if (profile instanceof Error) throw profile;
      const entry = {
        id: uuid(1300 + calls.addCalls.length),
        from: range.from,
        to: range.to,
        note: range.note ?? null,
      };
      profile = { ...profile, unavailability: [...profile.unavailability, entry] };
      return entry;
    },
    async removeUnavailability(id) {
      calls.removeCalls.push(id);
      if (fail) throw fail;
      if (profile instanceof Error) throw profile;
      profile = { ...profile, unavailability: profile.unavailability.filter((u) => u.id !== id) };
    },
  };
  return calls;
}

/** Every API as a fake, with any of them replaced. */
export function fakeApis(over: Partial<Apis> = {}): Apis {
  return {
    missions: fakeApi([pageOf([])]),
    users: fakeUsersApi(),
    skills: fakeSkillsApi(),
    settings: fakeSettingsApi(),
    audit: fakeAuditApi(),
    alerts: fakeAlertsApi(),
    inbox: fakeInboxApi(),
    assignments: fakeAssignmentsApi(),
    profile: fakeProfileApi(),
    crew: fakeCrewApi(),
    ...over,
  };
}
