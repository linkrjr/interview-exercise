import type { Skill } from '@mc/contracts';
import { useKeyboard } from '@opentui/react';
import { useRef, useState } from 'react';
import { FieldForm } from './field-form.js';
import { Popup } from './popup.js';
import type { SkillsApi } from './skills-api.js';
import { useTextEntry } from './text-entry.js';
import { Txt } from './theme.js';

export interface AddSkillPopupProps {
  api: SkillsApi;
  onClose(): void;
  /** Called after a skill was added, so the list behind can refresh. */
  onAdded(): void;
}

/** The form to add a skill to the catalogue: just its name, which is all the API needs. */
export function AddSkillPopup({ api, onClose, onAdded }: AddSkillPopupProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [added, setAdded] = useState<Skill>();
  const sending = useRef(false);

  // `q`, the arrow keys and Tab are the form's while it is open.
  useTextEntry(true);

  const submit = async (value: string) => {
    if (sending.current || added) return;
    const name = value.trim().replace(/\s+/g, ' ');
    if (!name) {
      setError('A name is required');
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      setAdded(await api.create(name));
      onAdded();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Adding the skill failed');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const close = useRef(onClose);
  close.current = onClose;
  useKeyboard((key) => {
    if (key.name === 'escape') close.current();
  });

  return (
    <Popup title=" Add a skill " maxWidth={64} maxHeight={10}>
      <box flexDirection="column" flexGrow={1}>
        {added ? (
          <Txt tone="good">Added {added.name}.</Txt>
        ) : (
          <FieldForm
            label="Name"
            placeholder="e.g. Orbital Piloting"
            busy={busy}
            error={error}
            hint="Enter add · Esc cancel"
            onSubmit={(value) => void submit(value)}
          />
        )}
      </box>
      <box flexShrink={0}>
        <Txt tone="muted">Esc {added ? 'close' : 'cancel'}</Txt>
      </box>
    </Popup>
  );
}
