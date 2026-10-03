import {
  MissionSchema,
  MissionSummarySchema,
  pageSchema,
  type CreateMissionRequest,
  type Mission,
  type MissionSummary,
  type UpdateMissionRequest,
  type Page,
} from '@mc/contracts';
import type { ApiClient } from '@mc/cli';
import { call } from './api-call.js';

export interface ListMissionsQuery {
  /** Only missions in one of these statuses, e.g. `pending_approval`. */
  status?: string[];
  cursor?: string;
  limit?: number;
}

/** What the mission screens need from the API: injectable, so the screens can be tested without it. */
export interface MissionsApi {
  list(query?: ListMissionsQuery): Promise<Page<MissionSummary>>;
  get(id: string): Promise<Mission>;
  /**
   * Approves or rejects a mission waiting for a decision. `version` is the one the Director saw: if the
   * mission has changed since, the server refuses (412) rather than deciding on something unseen.
   * For a rejection, `comment` is the reason, which the server requires.
   */
  decide(id: string, decision: Decision): Promise<Mission>;
  /** `mc missions create`: a new Draft mission led by the signed-in Lead. */
  create(input: CreateMissionRequest): Promise<Mission>;
  /** Changes the mission's own fields; only what is given is sent. `version` as for `decide`. */
  update(id: string, changes: UpdateMissionRequest, version: number): Promise<Mission>;
  /** Start crewing, reopen, submit, withdraw or cancel (the Lead's moves); `version` as for `decide`. */
  transition(id: string, action: LeadAction, version: number): Promise<Mission>;
  /** `mc missions requirements set`: replaces the requirements (an empty list clears them). */
  setRequirements(id: string, requirements: RequirementInput[], version: number): Promise<Mission>;
  /** `mc missions crew set`: replaces the tentative crew (an empty list clears it). */
  setCrew(id: string, crewMemberIds: string[], version: number): Promise<Mission>;
}

export type LeadAction = 'start_crewing' | 'reopen' | 'submit' | 'withdraw' | 'cancel';

export interface RequirementInput {
  skillId: string;
  minLevel: number;
  count: number;
}

export interface Decision {
  action: 'approve' | 'reject';
  comment?: string;
  version: number;
}

const MissionPage = pageSchema(MissionSummarySchema);

/** Reads missions with the CLI's client, so tokens refresh and errors read the way they do in `mc`. */
export function createMissionsApi(client: ApiClient): MissionsApi {
  return {
    list: (query = {}) =>
      call(
        () =>
          client.request('GET', '/v1/missions', {
            auth: 'user',
            query: { limit: query.limit, cursor: query.cursor },
            ...(query.status ? { repeat: { status: query.status } } : {}),
          }),
        (body) => MissionPage.parse(body),
      ),
    get: (id) =>
      call(
        () => client.request('GET', `/v1/missions/${encodeURIComponent(id)}`, { auth: 'user' }),
        (body) => MissionSchema.parse(body),
      ),
    decide: (id, { action, comment, version }) =>
      call(
        () =>
          client.request('POST', `/v1/missions/${encodeURIComponent(id)}/transitions`, {
            auth: 'user',
            body: { action, ...(comment ? { comment } : {}) },
            headers: { 'If-Match': `"${version}"` },
          }),
        (body) => MissionSchema.parse(body),
      ),
    create: (input) =>
      call(
        () => client.request('POST', '/v1/missions', { auth: 'user', body: input }),
        (body) => MissionSchema.parse(body),
      ),
    update: (id, changes, version) =>
      call(
        () =>
          client.request('PATCH', `/v1/missions/${encodeURIComponent(id)}`, {
            auth: 'user',
            body: changes,
            headers: { 'If-Match': `"${version}"` },
          }),
        (body) => MissionSchema.parse(body),
      ),
    transition: (id, action, version) =>
      call(
        () =>
          client.request('POST', `/v1/missions/${encodeURIComponent(id)}/transitions`, {
            auth: 'user',
            body: { action },
            headers: { 'If-Match': `"${version}"` },
          }),
        (body) => MissionSchema.parse(body),
      ),
    setRequirements: (id, requirements, version) =>
      call(
        () =>
          client.request('PUT', `/v1/missions/${encodeURIComponent(id)}/requirements`, {
            auth: 'user',
            body: { requirements },
            headers: { 'If-Match': `"${version}"` },
          }),
        (body) => MissionSchema.parse(body),
      ),
    setCrew: (id, crewMemberIds, version) =>
      call(
        () =>
          client.request('PUT', `/v1/missions/${encodeURIComponent(id)}/crew`, {
            auth: 'user',
            body: { crewMemberIds },
            headers: { 'If-Match': `"${version}"` },
          }),
        (body) => MissionSchema.parse(body),
      ),
  };
}
