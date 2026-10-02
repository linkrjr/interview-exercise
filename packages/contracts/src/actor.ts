import type { Role } from './role.js';

export type Actor =
  { kind: 'user'; userId: string; orgId: string; role: Role } | { kind: 'system' };
