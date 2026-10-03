import type { Apis } from './apis.js';
import { AlertsSection } from './alerts-section.js';
import { AssignmentsSection } from './assignments-section.js';
import { AuditSection } from './audit-section.js';
import { InboxSection } from './inbox-section.js';
import { NewMissionSection } from './new-mission-section.js';
import { MissionsSection } from './missions-section.js';
import { ProfileSection } from './profile-section.js';
import type { NavItem } from './navigation.js';
import type { SessionInfo } from './session.js';
import { SettingsSection } from './settings-section.js';
import { SkillsSection } from './skills-section.js';
import { Txt } from './theme.js';
import { UsersSection } from './users-section.js';

/** The screen of one navigation item. Anything not built yet shows what it is for. */
export function SectionBody({
  item,
  apis,
  session,
}: {
  item: NavItem;
  apis: Apis;
  session: SessionInfo;
}) {
  switch (item.id) {
    case 'approvals':
    case 'missions':
      return (
        <MissionsSection
          api={apis.missions}
          kind={item.id}
          skills={session.role === 'lead' ? apis.skills : undefined}
          crew={session.role === 'lead' ? apis.crew : undefined}
        />
      );
    case 'new-mission':
      return <NewMissionSection api={apis.missions} skills={apis.skills} crew={apis.crew} />;
    case 'users':
      return <UsersSection api={apis.users} />;
    case 'skills':
      return <SkillsSection api={apis.skills} canManage={session.role === 'director'} />;
    case 'settings':
      return <SettingsSection api={apis.settings} />;
    case 'audit':
      return <AuditSection api={apis.audit} />;
    case 'alerts':
      return <AlertsSection api={apis.alerts} />;
    case 'inbox':
      return <InboxSection api={apis.inbox} />;
    case 'profile':
      return <ProfileSection profile={apis.profile} skills={apis.skills} userId={session.userId} />;
    case 'assignments':
      return <AssignmentsSection api={apis.assignments} />;
    default:
      return (
        <box flexDirection="column" flexGrow={1} padding={1} gap={1}>
          <Txt tone="accent">{item.label}</Txt>
          <Txt>{item.summary}</Txt>
          <Txt tone="muted">This screen is not built yet.</Txt>
        </box>
      );
  }
}
