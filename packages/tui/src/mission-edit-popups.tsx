import {
  UpdateMissionRequestSchema,
  type CrewProfile,
  type Mission,
  type Skill,
} from '@mc/contracts';
import { useKeyboard } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';
import type { CrewApi } from './crew-api.js';
import { FormPopup } from './form-popup.js';
import type { MissionsApi, RequirementInput } from './missions-api.js';
import { Popup } from './popup.js';
import type { SkillsApi } from './skills-api.js';
import { useTextEntry } from './text-entry.js';
import { Txt } from './theme.js';

export interface MissionPopupProps {
  api: MissionsApi;
  mission: Mission;
  onClose(): void;
  /** Called with the mission as the server now has it, once a change went through. */
  onSaved(mission: Mission): void;
}

/** The first thing a schema found wrong, as one line. */
export function firstIssue(error: { issues: ReadonlyArray<{ message: string }> }): string {
  return error.issues[0]?.message ?? 'Invalid value';
}

/** The mission's own fields: name, dates, description. Only what changed is sent. */
export function EditMissionPopup({ api, mission, onClose, onSaved }: MissionPopupProps) {
  return (
    <FormPopup
      title="Edit mission"
      maxWidth={80}
      labelWidth={14}
      fields={[
        { key: 'name', label: 'Name', initial: mission.name },
        { key: 'startDate', label: 'Start', initial: mission.startDate, placeholder: 'YYYY-MM-DD' },
        { key: 'endDate', label: 'End', initial: mission.endDate, placeholder: 'YYYY-MM-DD' },
        { key: 'description', label: 'Description', initial: mission.description },
      ]}
      onSubmit={async (values) => {
        const changes: Record<string, string> = {};
        for (const key of ['name', 'startDate', 'endDate', 'description'] as const) {
          const value = (values[key] ?? '').trim();
          if (value !== mission[key]) changes[key] = value;
        }
        if (Object.keys(changes).length === 0) throw new Error('Nothing changed');
        const parsed = UpdateMissionRequestSchema.safeParse(changes);
        if (!parsed.success) throw new Error(firstIssue(parsed.error));
        onSaved(await api.update(mission.id, parsed.data, mission.version));
      }}
      onClose={onClose}
    />
  );
}

/** `Skill name:level:count`, split from the right so a name may contain colons (as `mc` does). */
export function parseRequirement(text: string): { name: string; minLevel: number; count: number } {
  const parts = text.split(':');
  const count = Number(parts.pop());
  const minLevel = Number(parts.pop());
  const name = parts.join(':').trim();
  if (
    !name ||
    !Number.isInteger(minLevel) ||
    minLevel < 1 ||
    minLevel > 5 ||
    !Number.isInteger(count) ||
    count < 1
  ) {
    throw new Error(
      `Invalid "${text.trim()}": use "Skill name:level:count", e.g. "Orbital Piloting:4:1" (level 1-5, count 1 or more)`,
    );
  }
  return { name, minLevel, count };
}

/** Turns the typed requirements into API input, naming skills from the catalogue. */
export function resolveRequirements(text: string, catalogue: readonly Skill[]): RequirementInput[] {
  return text
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const { name, minLevel, count } = parseRequirement(part);
      const skill = catalogue.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (!skill) throw new Error(`There is no skill called "${name}"`);
      return { skillId: skill.id, minLevel, count };
    });
}

async function allSkills(skills: SkillsApi): Promise<Skill[]> {
  const found: Skill[] = [];
  let cursor: string | undefined;
  do {
    const page = await skills.list({ cursor, limit: 100 });
    found.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return found;
}

/** The requirements as one line, `Skill:level:count; ...`; empty clears them all. */
export function RequirementsPopup({
  api,
  skills,
  mission,
  onClose,
  onSaved,
}: MissionPopupProps & { skills: SkillsApi }) {
  return (
    <FormPopup
      title="Requirements"
      maxWidth={100}
      labelWidth={14}
      hint="Skill:level:count; Skill:level:count · empty clears · Enter save · Esc cancel"
      fields={[
        {
          key: 'requirements',
          label: 'Requirements',
          initial: mission.requirements
            .map((r) => `${r.skillName}:${r.minLevel}:${r.count}`)
            .join('; '),
          placeholder: 'Orbital Piloting:4:1; Medicine:3:2',
        },
      ]}
      onSubmit={async (values) => {
        const text = values.requirements ?? '';
        const requirements = text.trim() ? resolveRequirements(text, await allSkills(skills)) : [];
        onSaved(await api.setRequirements(mission.id, requirements, mission.version));
      }}
      onClose={onClose}
    />
  );
}

/** Rows of the crew picker that fit, so the cursor row stays in view in a popup of fixed height. */
const VISIBLE_ROWS = 14;

async function allCrew(crew: CrewApi): Promise<CrewProfile[]> {
  const found: CrewProfile[] = [];
  let cursor: string | undefined;
  do {
    const page = await crew.list({ cursor, limit: 100 });
    found.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return found;
}

/**
 * Picking the tentative crew from the organisation's Crew Members: ↑/↓ move, Space ticks, Enter
 * saves (nobody ticked clears the crew), Esc cancels.
 */
export function CrewPopup({
  api,
  crew,
  mission,
  onClose,
  onSaved,
}: MissionPopupProps & { crew: CrewApi }) {
  const [members, setMembers] = useState<CrewProfile[]>();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set(mission.crew.map((c) => c.crewMemberId)),
  );
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const sending = useRef(false);

  useTextEntry(true);

  useEffect(() => {
    let cancelled = false;
    allCrew(crew).then(
      (loaded) => !cancelled && setMembers(loaded),
      (failure) =>
        !cancelled &&
        setError(failure instanceof Error ? failure.message : 'Could not load the crew'),
    );
    return () => {
      cancelled = true;
    };
  }, [crew]);

  const save = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      onSaved(await api.setCrew(mission.id, [...ticked], mission.version));
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Saving the crew failed');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const latest = useRef({ members, cursor, ticked, save, onClose });
  latest.current = { members, cursor, ticked, save, onClose };
  useKeyboard((key) => {
    const now = latest.current;
    if (key.name === 'escape') {
      if (!sending.current) now.onClose();
      return;
    }
    if (!now.members || sending.current) return;
    const last = Math.max(0, now.members.length - 1);
    if (key.name === 'down') setCursor(Math.min(last, now.cursor + 1));
    else if (key.name === 'up') setCursor(Math.max(0, now.cursor - 1));
    else if (key.name === 'pagedown') setCursor(Math.min(last, now.cursor + VISIBLE_ROWS));
    else if (key.name === 'pageup') setCursor(Math.max(0, now.cursor - VISIBLE_ROWS));
    else if (key.name === 'space') {
      const id = now.members[now.cursor]?.id;
      if (!id) return;
      const next = new Set(now.ticked);
      if (!next.delete(id)) next.add(id);
      setTicked(next);
    } else if (key.name === 'return') void now.save();
  });

  const first = members
    ? Math.max(0, Math.min(cursor - Math.floor(VISIBLE_ROWS / 2), members.length - VISIBLE_ROWS))
    : 0;
  const shown = members?.slice(first, first + VISIBLE_ROWS) ?? [];

  return (
    <Popup title=" Crew " maxWidth={80} maxHeight={VISIBLE_ROWS + 8}>
      <box flexDirection="column" flexGrow={1}>
        {!members ? (
          <Txt tone={error ? 'bad' : 'muted'}>{error ?? 'Loading the crew…'}</Txt>
        ) : members.length === 0 ? (
          <Txt>There are no Crew Members yet.</Txt>
        ) : (
          shown.map((member, index) => {
            const at = first + index;
            return (
              <box key={member.id} flexShrink={0}>
                <Txt tone={at === cursor ? 'accent' : 'normal'}>
                  {`${at === cursor ? '>' : ' '} [${ticked.has(member.id) ? 'x' : ' '}] ${
                    member.name ?? '(no name)'
                  } <${member.email}>  load ${member.load}`}
                </Txt>
              </box>
            );
          })
        )}
      </box>
      <box flexShrink={0} flexDirection="column">
        {members && error ? <Txt tone="bad">{error}</Txt> : null}
        <Txt tone="muted">
          {busy
            ? 'Saving…'
            : `${ticked.size} chosen · ↑/↓ move · Space tick · Enter save · Esc cancel`}
        </Txt>
      </box>
    </Popup>
  );
}
