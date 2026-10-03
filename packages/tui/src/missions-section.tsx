import type { MissionSummary } from '@mc/contracts';
import { useRef, useState } from 'react';
import { MissionList } from './mission-list.js';
import { MissionView } from './mission-view.js';
import type { CrewApi } from './crew-api.js';
import type { MissionsApi } from './missions-api.js';
import type { SkillsApi } from './skills-api.js';

const WAITING_FOR_APPROVAL = ['pending_approval'];

export interface MissionsSectionProps {
  api: MissionsApi;
  /** `approvals` lists only the missions waiting for a decision; `missions` lists them all. */
  kind: 'approvals' | 'missions';
  /** With these a Lead can set a mission's requirements and crew from its view. */
  skills?: SkillsApi;
  crew?: CrewApi;
}

/**
 * A list of missions and, once one is chosen, that mission in full as a popup over it. The list stays
 * visible and mounted underneath, so Esc returns to the same rows and the same place in them.
 */
export function MissionsSection({ api, kind, skills, crew }: MissionsSectionProps) {
  const [open, setOpen] = useState<MissionSummary>();
  // Bumped after a decision or a change: the list is then fetched again, since the mission has moved.
  const [generation, setGeneration] = useState(0);
  const decided = useRef(false);
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <MissionList
        key={generation}
        api={api}
        title={kind === 'approvals' ? 'Waiting for approval' : 'Missions'}
        status={kind === 'approvals' ? WAITING_FOR_APPROVAL : undefined}
        emptyText={
          kind === 'approvals' ? 'Nothing is waiting for approval.' : 'There are no missions yet.'
        }
        active={!open}
        onOpen={setOpen}
      />
      {open ? (
        <MissionView
          api={api}
          missionId={open.id}
          name={open.name}
          skills={skills}
          crew={crew}
          onChanged={() => (decided.current = true)}
          onBack={() => {
            setOpen(undefined);
            if (decided.current) {
              decided.current = false;
              setGeneration((g) => g + 1);
            }
          }}
        />
      ) : null}
    </box>
  );
}
