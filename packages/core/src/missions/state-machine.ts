import type { MissionAction, MissionStatus } from '@mc/contracts';

/** Who may perform a transition. */
export type TransitionActor = 'owner' | 'director' | 'system';

export type SystemAction = 'activate' | 'complete' | 'expire';
export type TransitionName = MissionAction | SystemAction;

export interface Transition {
  action: TransitionName;
  from: readonly MissionStatus[];
  to: MissionStatus;
  by: TransitionActor;
}

/**
 * The mission lifecycle (DESIGN.md §7.2) as data. This table is the single definition of which
 * transitions exist; the service applies the effects, and `transitions.ts` is the only code that
 * writes `missions.status`.
 */
export const TRANSITIONS: readonly Transition[] = [
  { action: 'start_crewing', from: ['draft'], to: 'crewing', by: 'owner' },
  { action: 'reopen', from: ['crewing'], to: 'draft', by: 'owner' },
  { action: 'submit', from: ['crewing'], to: 'pending_approval', by: 'owner' },
  { action: 'withdraw', from: ['pending_approval'], to: 'crewing', by: 'owner' },
  { action: 'approve', from: ['pending_approval'], to: 'approved', by: 'director' },
  { action: 'reject', from: ['pending_approval'], to: 'crewing', by: 'director' },
  {
    action: 'cancel',
    from: ['draft', 'crewing', 'pending_approval', 'approved'],
    to: 'cancelled',
    by: 'owner',
  },
  { action: 'activate', from: ['approved'], to: 'active', by: 'system' },
  { action: 'complete', from: ['active'], to: 'completed', by: 'system' },
  { action: 'expire', from: ['pending_approval'], to: 'crewing', by: 'system' },
];

export const transitionFor = (action: TransitionName): Transition => {
  const found = TRANSITIONS.find((t) => t.action === action);
  if (!found) throw new Error(`Unknown mission transition ${action}`);
  return found;
};

/** The user actions a kind of actor may take on a mission in this status. */
export function actionsFor(by: 'owner' | 'director', status: MissionStatus): MissionAction[] {
  return TRANSITIONS.filter((t) => t.by === by && t.from.includes(status)).map(
    (t) => t.action as MissionAction,
  );
}

/** Statuses in which the details and the requirements can be edited. */
export const EDITABLE_STATUSES: readonly MissionStatus[] = ['draft', 'crewing'];

/** Statuses in which holds are live: the crew is committed (DESIGN.md §8). */
export const HELD_STATUSES: readonly MissionStatus[] = ['pending_approval', 'approved', 'active'];

/** Statuses in which a Crew Member can see a mission they are assigned to ("Approved onward"). */
export const CREW_VISIBLE_STATUSES: readonly MissionStatus[] = ['approved', 'active', 'completed'];

export const TERMINAL_STATUSES: readonly MissionStatus[] = ['completed', 'cancelled'];
