import {
  CrewProfileSchema,
  CrewSkillSchema,
  UnavailabilitySchema,
  type CrewProfile,
  type CrewSkill,
  type Unavailability,
} from '@mc/contracts';
import type { ApiClient } from '@mc/cli';
import { call } from './api-call.js';

/** A Crew Member's own profile: skills and unavailability. */
export interface ProfileApi {
  get(userId: string): Promise<CrewProfile>;
  setSkill(skillId: string, level: number): Promise<CrewSkill>;
  removeSkill(skillId: string): Promise<void>;
  addUnavailability(range: { from: string; to: string; note?: string }): Promise<Unavailability>;
  removeUnavailability(id: string): Promise<void>;
}

/** `mc profile ...`, with the CLI's client. */
export function createProfileApi(client: ApiClient): ProfileApi {
  const id = encodeURIComponent;
  return {
    get: (userId) =>
      call(
        () => client.request('GET', `/v1/crew/${id(userId)}`, { auth: 'user' }),
        (body) => CrewProfileSchema.parse(body),
      ),
    setSkill: (skillId, level) =>
      call(
        () =>
          client.request('PUT', `/v1/crew/me/skills/${id(skillId)}`, {
            auth: 'user',
            body: { level },
          }),
        (body) => CrewSkillSchema.parse(body),
      ),
    removeSkill: async (skillId) => {
      await call(
        () => client.request('DELETE', `/v1/crew/me/skills/${id(skillId)}`, { auth: 'user' }),
        () => true,
      );
    },
    addUnavailability: (range) =>
      call(
        () =>
          client.request('POST', '/v1/crew/me/unavailability', {
            auth: 'user',
            body: { from: range.from, to: range.to, ...(range.note ? { note: range.note } : {}) },
          }),
        (body) => UnavailabilitySchema.parse(body),
      ),
    removeUnavailability: async (rangeId) => {
      await call(
        () =>
          client.request('DELETE', `/v1/crew/me/unavailability/${id(rangeId)}`, { auth: 'user' }),
        () => true,
      );
    },
  };
}
