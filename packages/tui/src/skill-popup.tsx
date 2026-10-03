import type { Skill } from '@mc/contracts';
import { useKeyboard } from '@opentui/react';
import { useRef, useState } from 'react';
import { FieldForm } from './field-form.js';
import { Popup } from './popup.js';
import type { SkillsApi } from './skills-api.js';
import { useTextEntry } from './text-entry.js';
import { Em, PALETTES, Txt } from './theme.js';

const P = PALETTES.popup;

export interface SkillPopupProps {
  api: SkillsApi;
  skill: Skill;
  /** Only a Director can rename; for anyone else the popup is read-only. */
  canManage: boolean;
  onClose(): void;
  /** Called after the skill was renamed, so the list it came from can refresh. */
  onChanged(): void;
}

/** One skill's info and, for a Director, the way to rename it. */
export function SkillPopup({
  api,
  skill: initial,
  canManage,
  onClose,
  onChanged,
}: SkillPopupProps) {
  const [skill, setSkill] = useState(initial);
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [renamed, setRenamed] = useState(false);
  const working = useRef(false);

  useTextEntry(renaming);

  const rename = async (value: string) => {
    if (working.current) return;
    const name = value.trim().replace(/\s+/g, ' ');
    if (!name) {
      setError('A name is required');
      return;
    }
    working.current = true;
    setBusy(true);
    setError(undefined);
    try {
      setSkill(await api.rename(skill.id, name));
      setRenaming(false);
      setRenamed(true);
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The rename failed');
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const latest = useRef({ renaming, onClose });
  latest.current = { renaming, onClose };
  useKeyboard((key) => {
    const now = latest.current;
    if (key.name === 'escape') {
      if (now.renaming) {
        if (!working.current) setRenaming(false);
      } else now.onClose();
    } else if (!now.renaming && canManage && key.name === 'r') {
      setError(undefined);
      setRenamed(false);
      setRenaming(true);
    }
  });

  const fact = (label: string, value: string) => (
    <Txt>
      <Em>{label.padEnd(9)}</Em>
      {value}
    </Txt>
  );

  return (
    <Popup title={` ${skill.name} `} maxWidth={72} maxHeight={13}>
      <box flexDirection="column" flexShrink={0}>
        {fact('Name', skill.name)}
        {fact('Created', skill.createdAt)}
        {fact('Id', skill.id)}
      </box>
      <box flexDirection="column" flexGrow={1} paddingTop={1}>
        {renamed ? <Txt tone="good">Renamed.</Txt> : null}
        {renaming ? (
          <FieldForm
            label="New name"
            initial={skill.name}
            busy={busy}
            error={error}
            hint="Enter save · Esc cancel"
            onSubmit={(value) => void rename(value)}
          />
        ) : canManage ? (
          <box flexDirection="row" flexShrink={0}>
            <box
              backgroundColor={P.buttonBg}
              onMouseDown={() => {
                setError(undefined);
                setRenamed(false);
                setRenaming(true);
              }}
            >
              <Txt tone="button"> Rename (r) </Txt>
            </box>
          </box>
        ) : null}
      </box>
      <box flexShrink={0}>
        <Txt tone="muted">Esc close</Txt>
      </box>
    </Popup>
  );
}
