import {
  MAX_UPCOMING_MISSIONS_MAX,
  MAX_UPCOMING_MISSIONS_MIN,
  isIanaTimeZone,
  type OrgSettings,
  type UpdateOrgSettingsRequest,
} from '@mc/contracts';
import { useKeyboard } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';
import type { SettingsApi } from './settings-api.js';
import { useTextEntry } from './text-entry.js';
import { FIELD, PALETTES, Txt } from './theme.js';

const P = PALETTES.screen;

type Field = 'timeZone' | 'cap' | 'save';
const ORDER: Field[] = ['timeZone', 'cap', 'save'];

interface FieldErrors {
  timeZone?: string;
  cap?: string;
}

/** The two settings as typed, checked the way the API checks them, before anything is sent. */
export function validate(
  timeZone: string,
  cap: string,
  current: OrgSettings,
): { patch: UpdateOrgSettingsRequest; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const patch: UpdateOrgSettingsRequest = {};
  const zone = timeZone.trim();
  if (!isIanaTimeZone(zone)) errors.timeZone = 'Not a valid IANA time zone, e.g. Europe/London';
  else if (zone !== current.timeZone) patch.timeZone = zone;

  const typed = cap.trim();
  const n = Number(typed);
  if (
    typed === '' ||
    !Number.isInteger(n) ||
    n < MAX_UPCOMING_MISSIONS_MIN ||
    n > MAX_UPCOMING_MISSIONS_MAX
  ) {
    errors.cap = `A whole number from ${MAX_UPCOMING_MISSIONS_MIN} to ${MAX_UPCOMING_MISSIONS_MAX}`;
  } else if (n !== current.maxUpcomingMissions) patch.maxUpcomingMissions = n;
  return { patch, errors };
}

/**
 * The organisation's settings as a form: every setting an editable field, and a Save button at the
 * bottom. Tab (Shift+Tab) moves between the fields and Save, Enter saves, and only what changed is
 * sent. The form starts at rest, so ←/→ and Tab still choose sections; Enter (or a click on a field)
 * engages it and the keys are then its own, until Esc lets go again.
 */
export function SettingsSection({ api }: { api: SettingsApi }) {
  const [saved, setSaved] = useState<OrgSettings>();
  const [loadError, setLoadError] = useState<string>();
  const [timeZone, setTimeZone] = useState('');
  const [cap, setCap] = useState('');
  const [focus, setFocus] = useState<Field>('timeZone');
  // Not engaged on arrival, so ←/→ can carry on past this section; Enter (or a click) starts editing.
  const [engaged, setEngaged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<{ text: string; tone: 'good' | 'bad' | 'muted' }>();
  const sending = useRef(false);

  useTextEntry(engaged);

  const show = (settings: OrgSettings) => {
    setSaved(settings);
    setTimeZone(settings.timeZone);
    setCap(String(settings.maxUpcomingMissions));
  };

  useEffect(() => {
    let cancelled = false;
    api
      .get()
      .then((settings) => !cancelled && show(settings))
      .catch(
        (failure) =>
          !cancelled &&
          setLoadError(failure instanceof Error ? failure.message : 'Could not load the settings'),
      );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const save = async () => {
    if (!saved || sending.current) return;
    const { patch, errors: found } = validate(timeZone, cap, saved);
    setErrors(found);
    setMessage(undefined);
    if (Object.keys(found).length > 0) return;
    if (Object.keys(patch).length === 0) {
      setMessage({ text: 'Nothing has changed.', tone: 'muted' });
      return;
    }
    sending.current = true;
    setBusy(true);
    try {
      show(await api.update(patch));
      setMessage({ text: 'Saved.', tone: 'good' });
    } catch (failure) {
      setMessage({
        text: failure instanceof Error ? failure.message : 'Saving failed',
        tone: 'bad',
      });
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const latest = useRef({ engaged, focus, save });
  latest.current = { engaged, focus, save };
  useKeyboard((key) => {
    const now = latest.current;
    if (key.name === 'escape') {
      if (now.engaged) setEngaged(false);
    } else if (!now.engaged) {
      if (key.name === 'return') setEngaged(true);
    } else if (key.name === 'tab') {
      const step = key.shift ? -1 : 1;
      setFocus(ORDER[(ORDER.indexOf(now.focus) + step + ORDER.length) % ORDER.length]!);
    } else if (key.name === 'return' && now.focus === 'save') void now.save();
  });

  if (loadError) {
    return (
      <box key="error" padding={1}>
        <Txt tone="bad">{loadError}</Txt>
      </box>
    );
  }
  if (!saved) {
    return (
      <box key="loading" padding={1}>
        <Txt tone="muted">Loading…</Txt>
      </box>
    );
  }

  const active = (field: Field) => engaged && focus === field;
  const field = (
    name: 'timeZone' | 'cap',
    label: string,
    hint: string,
    value: string,
    onInput: (v: string) => void,
  ) => (
    <box key={name} flexDirection="column" flexShrink={0}>
      <Txt tone={active(name) ? 'accent' : 'muted'}>{label}</Txt>
      <box
        border
        borderStyle="rounded"
        borderColor={active(name) ? P.accent : P.border}
        backgroundColor={FIELD.bg}
        height={3}
        paddingLeft={1}
        onMouseDown={() => {
          setEngaged(true);
          setFocus(name);
        }}
      >
        <input
          focused={active(name) && !busy}
          value={value}
          textColor={FIELD.fg}
          backgroundColor={FIELD.bg}
          focusedBackgroundColor={FIELD.bg}
          onInput={onInput}
          onSubmit={() => void save()}
        />
      </box>
      <Txt tone={errors[name] ? 'bad' : 'muted'}>{errors[name] ?? hint}</Txt>
    </box>
  );

  return (
    <box key="form" flexDirection="column" flexGrow={1} minHeight={0} padding={1} gap={1}>
      <Txt tone="accent">Organisation settings</Txt>
      {field(
        'timeZone',
        'Time zone',
        'IANA name, e.g. Europe/London. Decides what "today" is for the scheduler.',
        timeZone,
        setTimeZone,
      )}
      {field(
        'cap',
        'Most upcoming missions per crew member',
        `${MAX_UPCOMING_MISSIONS_MIN} to ${MAX_UPCOMING_MISSIONS_MAX}. Lowering it never releases a crew member already held.`,
        cap,
        setCap,
      )}

      <box flexGrow={1} />

      <box flexDirection="row" flexShrink={0} gap={2}>
        <box
          border
          borderStyle="rounded"
          borderColor={active('save') ? P.accent : P.border}
          backgroundColor={active('save') ? P.fg : P.buttonBg}
          height={3}
          width={14}
          alignItems="center"
          justifyContent="center"
          onMouseDown={() => {
            setEngaged(true);
            setFocus('save');
            void save();
          }}
        >
          <Txt tone="button">{busy ? 'Saving…' : 'Save'}</Txt>
        </box>
        <box flexDirection="column" justifyContent="center">
          {message ? <Txt tone={message.tone}>{message.text}</Txt> : null}
          <Txt tone="muted">
            {engaged
              ? 'Tab next field · Enter save · Esc leave the form'
              : '←/→ or Tab section · Enter edit the form'}
          </Txt>
        </box>
      </box>
    </box>
  );
}
