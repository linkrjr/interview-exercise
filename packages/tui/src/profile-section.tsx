import type { CrewSkill, Page, Skill, Unavailability } from '@mc/contracts';
import { SKILL_LEVEL_MAX, SKILL_LEVEL_MIN } from '@mc/contracts';
import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Column } from './data-table.js';
import type { FieldDef } from './form.js';
import { Form } from './form.js';
import { FormPopup } from './form-popup.js';
import { InfoPopup } from './info-popup.js';
import { ListSection } from './list-section.js';
import { Popup } from './popup.js';
import type { ProfileApi } from './profile-api.js';
import type { SkillsApi } from './skills-api.js';
import { PALETTES, Txt } from './theme.js';

const P = PALETTES.screen;
const POPUP = PALETTES.popup;

const LEVELS = Array.from({ length: SKILL_LEVEL_MAX - SKILL_LEVEL_MIN + 1 }, (_, i) => {
  const level = String(SKILL_LEVEL_MIN + i);
  return { value: level, label: level };
});

/** A real calendar date typed as `YYYY-MM-DD`. */
export function isDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

const SKILL_COLUMNS: readonly Column<CrewSkill>[] = [
  { header: 'SKILL', value: (s) => s.name },
  { header: 'LEVEL', value: (s) => `${s.level} / ${SKILL_LEVEL_MAX}` },
];
const RANGE_COLUMNS: readonly Column<Unavailability>[] = [
  { header: 'FROM', value: (u) => u.from },
  { header: 'TO', value: (u) => u.to },
  { header: 'NOTE', value: (u) => u.note ?? '' },
];

type Tab = 'skills' | 'unavailability';
const TABS: ReadonlyArray<{ id: Tab; label: string; key: string; menu: string }> = [
  { id: 'skills', label: 'Skills', key: '1', menu: 'Set a skill (s)' },
  { id: 'unavailability', label: 'Unavailability', key: '2', menu: 'Add unavailability (u)' },
];

/** The popup of one of my skills: change its level (Enter) or remove it (x, after asking). */
function SkillPopup(props: {
  api: ProfileApi;
  skill: CrewSkill;
  onClose(): void;
  onChanged(): void;
}) {
  const { api, skill } = props;
  const [level, setLevel] = useState(skill.level);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'good' | 'bad' }>();
  const [confirming, setConfirming] = useState(false);
  const [removed, setRemoved] = useState(false);
  const working = useRef(false);

  const run = async (work: () => Promise<string>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setMessage(undefined);
    try {
      setMessage({ text: await work(), tone: 'good' });
      props.onChanged();
    } catch (failure) {
      setMessage({ text: failure instanceof Error ? failure.message : 'That failed', tone: 'bad' });
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const latest = useRef({ confirming, removed, run });
  latest.current = { confirming, removed, run };
  useKeyboard((key) => {
    const now = latest.current;
    if (key.name === 'escape') {
      if (now.confirming) {
        if (!working.current) setConfirming(false);
      } else props.onClose();
    } else if (now.removed) return;
    else if (now.confirming) {
      if (key.name === 'return')
        void now.run(async () => {
          await api.removeSkill(skill.skillId);
          setRemoved(true);
          setConfirming(false);
          return 'Removed.';
        });
    } else if (key.name === 'x') setConfirming(true);
  });

  const fields: FieldDef[] = [
    { key: 'level', label: 'Level', kind: 'choice', options: LEVELS, initial: String(level) },
  ];
  return (
    <Popup title={` ${skill.name} `} maxWidth={72} maxHeight={13}>
      <Txt>
        {skill.name}: level {level} of {SKILL_LEVEL_MAX}
      </Txt>
      <box flexDirection="column" flexGrow={1} paddingTop={1}>
        {removed ? null : confirming ? (
          <Txt tone="bad">
            {busy
              ? 'Working…'
              : `Remove ${skill.name} from your profile? Enter confirm · Esc cancel`}
          </Txt>
        ) : (
          <Form
            fields={fields}
            busy={busy}
            hint="←/→ level · Enter save · x remove · Esc close"
            labelWidth={8}
            onSubmit={(values) =>
              void run(async () => {
                const saved = await api.setSkill(skill.skillId, Number(values.level));
                setLevel(saved.level);
                return 'Saved.';
              })
            }
          />
        )}
        {message ? <Txt tone={message.tone}>{message.text}</Txt> : null}
      </box>
      <box flexShrink={0}>
        <Txt tone="muted">Esc close</Txt>
      </box>
    </Popup>
  );
}

/** Choosing one of the catalogue's skills and a level for it. */
function SetSkillPopup(props: {
  profile: ProfileApi;
  skills: SkillsApi;
  onClose(): void;
  onChanged(): void;
}) {
  const [catalogue, setCatalogue] = useState<Skill[]>();
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const all: Skill[] = [];
      let page: Page<Skill> | undefined;
      do {
        page = await props.skills.list({ cursor: page?.nextCursor ?? undefined, limit: 100 });
        all.push(...page.items);
      } while (page.nextCursor);
      if (!cancelled) setCatalogue(all);
    })().catch(
      (e) => !cancelled && setProblem(e instanceof Error ? e.message : 'Could not load the skills'),
    );
    return () => {
      cancelled = true;
    };
  }, [props.skills]);

  const escape = useRef(props.onClose);
  escape.current = props.onClose;
  useKeyboard((key) => {
    if (!catalogue && key.name === 'escape') escape.current();
  });

  if (!catalogue || catalogue.length === 0) {
    return (
      <Popup title=" Set a skill " maxWidth={60} maxHeight={7}>
        <box flexGrow={1}>
          <Txt tone={problem ? 'bad' : 'muted'}>
            {problem ??
              (catalogue
                ? 'The catalogue is empty: a Director adds the skills.'
                : 'Loading the skills…')}
          </Txt>
        </box>
        <Txt tone="muted">Esc close</Txt>
      </Popup>
    );
  }
  return (
    <FormPopup
      title="Set a skill"
      fields={[
        {
          key: 'skill',
          label: 'Skill',
          kind: 'choice',
          options: catalogue.map((s) => ({ value: s.id, label: s.name })),
        },
        { key: 'level', label: 'Level', kind: 'choice', options: LEVELS, initial: '3' },
      ]}
      hint="Tab next field · ←/→ choose · Enter save · Esc cancel"
      labelWidth={8}
      onSubmit={async (values) => {
        await props.profile.setSkill(values.skill!, Number(values.level));
      }}
      onClose={props.onClose}
      onChanged={props.onChanged}
    />
  );
}

/**
 * A Crew Member's own profile (`mc profile ...`): their skills and the days they are unavailable, as two
 * framed tables behind a small tab bar (1 and 2, or a click). Each row opens a popup; a menu at the
 * bottom adds a skill or a range. Lists refresh when a popup that changed something closes.
 */
export function ProfileSection(props: { profile: ProfileApi; skills: SkillsApi; userId?: string }) {
  const { profile, userId } = props;
  const [tab, setTab] = useState<Tab>('skills');
  const [adding, setAdding] = useState(false);
  const [generation, setGeneration] = useState(0);
  const changed = useRef(false);

  const fetchSkills = useCallback(async () => {
    if (!userId) throw new Error('Your user id is not stored: sign out and in again.');
    const me = await profile.get(userId);
    return { items: [...me.skills].sort((a, b) => a.name.localeCompare(b.name)), nextCursor: null };
  }, [profile, userId]);
  const fetchRanges = useCallback(async () => {
    if (!userId) throw new Error('Your user id is not stored: sign out and in again.');
    const me = await profile.get(userId);
    return {
      items: [...me.unavailability].sort((a, b) => a.from.localeCompare(b.from)),
      nextCursor: null,
    };
  }, [profile, userId]);

  const refresh = () => {
    if (changed.current) {
      changed.current = false;
      setGeneration((g) => g + 1);
    }
  };

  // The tab and menu keys work only while no popup is open.
  const [popupOpen, setPopupOpen] = useState(false);
  useKeyboard((key) => {
    if (popupOpen || adding) return;
    if (key.name === '1') setTab('skills');
    else if (key.name === '2') setTab('unavailability');
    else if (key.name === 's' && tab === 'skills') setAdding(true);
    else if (key.name === 'u' && tab === 'unavailability') setAdding(true);
  });

  const current = TABS.find((t) => t.id === tab)!;
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingTop={1} gap={2}>
        {TABS.map((t) => (
          <box
            key={t.id}
            backgroundColor={t.id === tab ? P.selectedBg : undefined}
            onMouseDown={() => !popupOpen && !adding && setTab(t.id)}
          >
            <Txt tone={t.id === tab ? 'selected' : 'normal'}>
              {' '}
              {t.key} {t.label}{' '}
            </Txt>
          </box>
        ))}
      </box>

      {tab === 'skills' ? (
        <ListSection
          key={`skills-${generation}`}
          fetchPage={fetchSkills}
          columns={SKILL_COLUMNS}
          rowKey={(s) => s.skillId}
          title="My skills"
          emptyText="You have no skills yet: set one below."
          onPopup={setPopupOpen}
          paused={adding}
          renderPopup={({ row, close, changed: mark }) => (
            <SkillPopup api={profile} skill={row} onClose={close} onChanged={mark} />
          )}
        />
      ) : (
        <ListSection
          key={`ranges-${generation}`}
          fetchPage={fetchRanges}
          columns={RANGE_COLUMNS}
          rowKey={(u) => u.id}
          title="When I am unavailable"
          emptyText="You have not marked any unavailable days."
          onPopup={setPopupOpen}
          paused={adding}
          renderPopup={({ row, close, changed: mark }) => (
            <InfoPopup
              title={`${row.from} to ${row.to}`}
              facts={[
                { label: 'From', value: row.from },
                { label: 'To', value: row.to },
                { label: 'Note', value: row.note || '-' },
                { label: 'Id', value: row.id },
              ]}
              actions={[
                {
                  key: 'x',
                  label: 'Remove',
                  danger: true,
                  confirm: 'Remove this range?',
                  run: async () => {
                    await profile.removeUnavailability(row.id);
                    mark();
                    return { message: 'Removed.', hide: ['x'] };
                  },
                },
              ]}
              maxHeight={13}
              onClose={close}
            />
          )}
        />
      )}

      <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingTop={1}>
        <box backgroundColor={P.buttonBg} onMouseDown={() => !popupOpen && setAdding(true)}>
          <Txt tone="button"> {current.menu} </Txt>
        </box>
      </box>

      {adding && tab === 'skills' ? (
        <SetSkillPopup
          profile={profile}
          skills={props.skills}
          onClose={() => {
            setAdding(false);
            refresh();
          }}
          onChanged={() => (changed.current = true)}
        />
      ) : null}
      {adding && tab === 'unavailability' ? (
        <FormPopup
          title="Add unavailability"
          fields={[
            { key: 'from', label: 'From', placeholder: 'YYYY-MM-DD' },
            { key: 'to', label: 'To', placeholder: 'YYYY-MM-DD (inclusive)' },
            { key: 'note', label: 'Note', placeholder: 'private, optional' },
          ]}
          labelWidth={8}
          onSubmit={async (values) => {
            const from = values.from!.trim();
            const to = values.to!.trim();
            if (!isDate(from)) throw new Error('From must be a date, YYYY-MM-DD');
            if (!isDate(to)) throw new Error('To must be a date, YYYY-MM-DD');
            if (from > to) throw new Error('The end date must not be before the start date');
            await profile.addUnavailability({ from, to, note: values.note!.trim() || undefined });
          }}
          onClose={() => {
            setAdding(false);
            refresh();
          }}
          onChanged={() => (changed.current = true)}
        />
      ) : null}
    </box>
  );
}
