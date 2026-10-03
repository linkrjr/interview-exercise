import { RoleSchema, type Role } from '@mc/contracts';

export interface NavItem {
  id: string;
  label: string;
  /** What this section is for, shown until its screen exists. */
  summary: string;
}

/** Signing out is an action, not a section: it is the one item every role has. */
export const SIGN_OUT: NavItem = {
  id: 'sign-out',
  label: 'Sign out',
  summary: 'End this session and forget the stored sign-in.',
};

const INBOX: NavItem = {
  id: 'inbox',
  label: 'Inbox',
  summary: 'Your notifications: approvals, assignments and cancellations.',
};

/**
 * What each role can do, from the role matrix of DESIGN.md §6 and the commands the CLI offers each
 * role. Authorisation stays with the API; this decides what the bar offers, and a role is never
 * offered what it cannot use.
 */
const SECTIONS: Record<Role, readonly NavItem[]> = {
  director: [
    {
      id: 'approvals',
      label: 'Approvals',
      summary: 'Missions waiting for your decision: approve or reject.',
    },
    { id: 'missions', label: 'Missions', summary: 'Every mission of the organisation.' },
    {
      id: 'users',
      label: 'Users',
      summary: 'Everyone in the organisation: invite, reinvite and deactivate.',
    },
    { id: 'skills', label: 'Skills', summary: 'The skill catalogue: add and rename skills.' },
    { id: 'settings', label: 'Settings', summary: 'Time zone and the upcoming-mission cap.' },
    { id: 'audit', label: 'Audit log', summary: 'Who changed what, newest first.' },
    { id: 'alerts', label: 'Alerts', summary: 'Operational alerts, such as scheduler failures.' },
    INBOX,
  ],
  lead: [
    { id: 'missions', label: 'Missions', summary: 'All missions; edit, crew and submit your own.' },
    {
      id: 'new-mission',
      label: 'New mission',
      summary: 'Plan a mission: dates, requirements, crew.',
    },
    { id: 'skills', label: 'Skills', summary: 'The skill catalogue (read only).' },
    INBOX,
  ],
  crew: [
    {
      id: 'profile',
      label: 'My profile',
      summary: 'Your skills and the days you are unavailable.',
    },
    {
      id: 'assignments',
      label: 'My assignments',
      summary: 'Missions you are assigned to; acknowledge them.',
    },
    INBOX,
  ],
};

/**
 * The bar for a role, ending with Sign out. A role the TUI does not recognise (or none) gets only
 * Sign out, never a guess.
 */
export function navigationFor(role: string | undefined): readonly NavItem[] {
  const parsed = RoleSchema.safeParse(role);
  return parsed.success ? [...SECTIONS[parsed.data], SIGN_OUT] : [SIGN_OUT];
}
