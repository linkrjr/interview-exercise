import { CreateMissionRequestSchema, type Mission } from '@mc/contracts';
import { useKeyboard } from '@opentui/react';
import { useState } from 'react';
import { FormPopup } from './form-popup.js';
import type { CrewApi } from './crew-api.js';
import { firstIssue } from './mission-edit-popups.js';
import { MissionView } from './mission-view.js';
import type { MissionsApi } from './missions-api.js';
import type { SkillsApi } from './skills-api.js';
import { PALETTES, Txt } from './theme.js';

const P = PALETTES.screen;

export interface NewMissionSectionProps {
  api: MissionsApi;
  skills: SkillsApi;
  crew: CrewApi;
}

/**
 * Planning a mission. The section starts at rest, so ←/→ and Tab carry on past it; `n`, Enter or the
 * button opens the form (Esc closes it). Once created, the new mission is shown in full so the Lead can go on with its requirements and crew.
 */
export function NewMissionSection({ api, skills, crew }: NewMissionSectionProps) {
  const [form, setForm] = useState(false);
  const [created, setCreated] = useState<Mission>();
  // A new form each time, so it never starts with the last mission's values.
  const [attempt, setAttempt] = useState(0);

  useKeyboard((key) => {
    if (!form && !created && (key.name === 'n' || key.name === 'return')) {
      setAttempt((a) => a + 1);
      setForm(true);
    }
  });

  return (
    <box flexDirection="column" flexGrow={1} padding={1} gap={1}>
      <Txt tone="accent">New mission</Txt>
      <Txt>Plan a mission: name, dates and a description. Requirements and crew come next.</Txt>
      {created ? (
        <Txt tone="good">Created {created.name}.</Txt>
      ) : (
        <box flexDirection="row" flexShrink={0}>
          <box
            backgroundColor={P.buttonBg}
            onMouseDown={() => {
              setAttempt((a) => a + 1);
              setForm(true);
            }}
          >
            <Txt tone="button"> Plan a mission (n) </Txt>
          </box>
        </box>
      )}

      {form && !created ? (
        <FormPopup
          key={attempt}
          title="New mission"
          maxWidth={80}
          labelWidth={14}
          fields={[
            { key: 'name', label: 'Name', placeholder: 'e.g. Relay station' },
            { key: 'startDate', label: 'Start', placeholder: 'YYYY-MM-DD' },
            { key: 'endDate', label: 'End (last day)', placeholder: 'YYYY-MM-DD' },
            { key: 'description', label: 'Description', placeholder: 'optional' },
          ]}
          onSubmit={async (values) => {
            const parsed = CreateMissionRequestSchema.safeParse({
              name: values.name ?? '',
              startDate: values.startDate ?? '',
              endDate: values.endDate ?? '',
              description: values.description ?? '',
            });
            if (!parsed.success) throw new Error(firstIssue(parsed.error));
            setCreated(await api.create(parsed.data));
          }}
          onClose={() => setForm(false)}
        />
      ) : null}

      {created ? (
        <MissionView
          api={api}
          skills={skills}
          crew={crew}
          missionId={created.id}
          name={created.name}
          onBack={() => setCreated(undefined)}
        />
      ) : null}
    </box>
  );
}
