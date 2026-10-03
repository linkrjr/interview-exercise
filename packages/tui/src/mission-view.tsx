import type { Mission } from '@mc/contracts';
import { useKeyboard } from '@opentui/react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useEffect, useRef, useState } from 'react';
import { CrewPopup, EditMissionPopup, RequirementsPopup } from './mission-edit-popups.js';
import type { CrewApi } from './crew-api.js';
import type { LeadAction, MissionsApi } from './missions-api.js';
import type { SkillsApi } from './skills-api.js';
import { Popup } from './popup.js';
import { FIELD, PALETTES, Txt } from './theme.js';
import { useTextEntry } from './text-entry.js';

const P = PALETTES.popup;

export interface Line {
  text: string;
  /** `heading` lines are the section titles; `muted` ones are secondary. */
  tone?: 'heading' | 'muted';
}

/** Everything about a mission, as lines: its fields, requirements, crew, crew check and decisions. */
export function missionLines(m: Mission): Line[] {
  const lines: Line[] = [
    { text: m.name, tone: 'heading' },
    { text: `Status: ${m.status}    Version: ${m.version}` },
    { text: `Dates: ${m.startDate} to ${m.endDate}` },
    { text: `Lead: ${m.leadName ?? m.leadId}` },
    { text: `Created: ${m.createdAt}`, tone: 'muted' },
    { text: `Id: ${m.id}`, tone: 'muted' },
    { text: '' },
    { text: 'Description', tone: 'heading' },
    { text: m.description || '(none)' },
    { text: '' },
    { text: 'Requirements', tone: 'heading' },
    ...(m.requirements.length
      ? m.requirements.map((r) => ({
          text: `  ${r.skillName}  level ${r.minLevel}+  x${r.count}`,
        }))
      : [{ text: '  (none)' }]),
    { text: '' },
    { text: 'Crew', tone: 'heading' },
    ...(m.crew.length
      ? m.crew.map((c) => ({
          text: `  ${c.name ?? '(no name)'} <${c.email}>${
            c.acknowledgedAt ? `  acknowledged ${c.acknowledgedAt}` : '  not acknowledged'
          }`,
        }))
      : [{ text: '  (none)' }]),
  ];
  if (m.crewValidation) {
    const v = m.crewValidation;
    lines.push({ text: '' }, { text: 'Crew check', tone: 'heading' });
    lines.push({ text: v.valid ? '  ready to submit' : '  NOT ready to submit' });
    for (const issue of v.assignmentIssues) {
      const who = m.crew.find((c) => c.crewMemberId === issue.crewMemberId);
      lines.push({ text: `  - ${who?.name ?? who?.email ?? issue.crewMemberId} is ${issue.code}` });
    }
    for (const u of v.unmetRequirements) {
      const skill = m.requirements.find((r) => r.skillId === u.skillId)?.skillName ?? u.skillId;
      lines.push({
        text: `  - ${skill} (level ${u.minLevel}+): needs ${u.required}, has ${u.met}`,
      });
    }
  }
  if (m.decisions.length) {
    lines.push({ text: '' }, { text: 'Decisions', tone: 'heading' });
    for (const d of m.decisions) {
      lines.push({ text: `  ${d.decidedAt}  ${d.decision}${d.comment ? `: ${d.comment}` : ''}` });
    }
  }
  lines.push(
    { text: '' },
    {
      text: `You can: ${m.allowedActions.length ? m.allowedActions.join(', ') : '(nothing)'}`,
      tone: 'muted',
    },
  );
  return lines;
}

type Decision = 'approve' | 'reject';

const FORM: Record<
  Decision,
  { title: string; done: string; color: string; action: string; required: boolean }
> = {
  approve: {
    title: 'Approve: comment (optional)',
    done: 'Approved.',
    color: P.good,
    action: P.successBg,
    required: false,
  },
  reject: {
    title: 'Reject: reason (required)',
    done: 'Rejected.',
    color: P.bad,
    action: P.dangerBg,
    required: true,
  },
};

/** The Lead's moves: the key and button, the question asked first, and what is said once it is done. */
const MOVES: Record<
  LeadAction,
  { key: string; label: string; ask: string; done: string; danger?: boolean }
> = {
  start_crewing: {
    key: 's',
    label: 'Start crewing',
    ask: 'Start crewing this mission?',
    done: 'Now being crewed.',
  },
  reopen: {
    key: 'o',
    label: 'Reopen',
    ask: 'Take the mission back to Draft? Its crew is cleared.',
    done: 'Back in draft.',
  },
  submit: {
    key: 'u',
    label: 'Submit',
    ask: 'Submit the crew for approval?',
    done: 'Submitted for approval.',
  },
  withdraw: {
    key: 'w',
    label: 'Withdraw',
    ask: 'Withdraw the submission and go back to Crewing?',
    done: 'Withdrawn: being crewed again.',
  },
  cancel: {
    key: 'x',
    label: 'Cancel mission',
    ask: 'Cancel this mission? This cannot be undone.',
    done: 'Cancelled.',
    danger: true,
  },
};
const MOVE_ORDER = Object.keys(MOVES) as LeadAction[];

type Editor = 'edit' | 'requirements' | 'crew';

/** Which edits the server's `allowedActions` imply: only the owning Lead can start or reopen a mission. */
export function allowedEdits(actions: readonly string[]): Editor[] {
  const edits: Editor[] = [];
  if (actions.includes('start_crewing') || actions.includes('reopen')) {
    edits.push('edit', 'requirements');
  }
  if (actions.includes('reopen')) edits.push('crew');
  return edits;
}

const EDITORS: Record<Editor, { key: string; label: string }> = {
  edit: { key: 'e', label: 'Edit' },
  requirements: { key: 'p', label: 'Requirements' },
  crew: { key: 'c', label: 'Crew' },
};

export interface MissionViewProps {
  api: MissionsApi;
  missionId: string;
  /** Shown while the mission loads. */
  name: string;
  onBack(): void;
  /** Called after an approval or rejection went through, so the list it came from can refresh. */
  onDecided?(): void;
  /** Called after any change (a decision, a move, an edit), so the list it came from can refresh. */
  onChanged?(): void;
  /** With these a Lead can set the requirements and the crew; without them those buttons are not shown. */
  skills?: SkillsApi;
  crew?: CrewApi;
}

/**
 * One mission in full, as a bordered popup over the list it was opened from (which stays visible
 * around it); scrollable, and Esc closes it. A Director sees
 * Approve and Reject (keys a and r) only while the server says the mission can be decided. A decision
 * takes a small form (a comment, or the required reason for a rejection) and leaves the screen on the
 * updated mission, with the buttons gone.
 */
export function MissionView({
  api,
  missionId,
  name,
  onBack,
  onDecided,
  onChanged,
  skills,
  crew,
}: MissionViewProps) {
  const [mission, setMission] = useState<Mission>();
  const [error, setError] = useState<string>();
  const [form, setForm] = useState<Decision>();
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; tone: 'good' | 'bad' }>();
  const [asking, setAsking] = useState<LeadAction>();
  const [editor, setEditor] = useState<Editor>();
  const [moveError, setMoveError] = useState<string>();
  const scroller = useRef<ScrollBoxRenderable>(null);
  const submitting = useRef(false);

  useTextEntry(form !== undefined);

  useEffect(() => {
    let cancelled = false;
    api
      .get(missionId)
      .then((loaded) => !cancelled && setMission(loaded))
      .catch(
        (failure) =>
          !cancelled &&
          setError(failure instanceof Error ? failure.message : 'Could not load the mission'),
      );
    return () => {
      cancelled = true;
    };
  }, [api, missionId]);

  const allowed = (action: Decision | LeadAction) =>
    Boolean(mission?.allowedActions.includes(action));

  const open = (action: Decision) => {
    if (!allowed(action) || submitting.current || asking || editor) return;
    setFormError(undefined);
    setForm(action);
  };

  const ask = (action: LeadAction) => {
    if (!allowed(action) || submitting.current || form || editor) return;
    setMoveError(undefined);
    setAsking(action);
  };

  const edit = (which: Editor) => {
    const available =
      allowedEdits(mission?.allowedActions ?? []).includes(which) &&
      (which === 'edit' || (which === 'requirements' ? skills : crew));
    if (!available || submitting.current || form || asking) return;
    setOutcome(undefined);
    setEditor(which);
  };

  const move = async (action: LeadAction) => {
    if (!mission || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setMoveError(undefined);
    try {
      setMission(await api.transition(missionId, action, mission.version));
      setAsking(undefined);
      setOutcome({ text: MOVES[action].done, tone: 'good' });
      onChanged?.();
    } catch (failure) {
      setMoveError(failure instanceof Error ? failure.message : 'That failed');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const saved = (updated: Mission, text: string) => {
    setMission(updated);
    setOutcome({ text, tone: 'good' });
    onChanged?.();
  };

  const submit = async (action: Decision, value: string) => {
    if (!mission || submitting.current) return;
    const comment = value.trim();
    if (FORM[action].required && !comment) {
      setFormError('A reason is required');
      return;
    }
    submitting.current = true;
    setBusy(true);
    setFormError(undefined);
    try {
      setMission(await api.decide(missionId, { action, comment, version: mission.version }));
      setForm(undefined);
      setOutcome({ text: FORM[action].done, tone: action === 'approve' ? 'good' : 'bad' });
      onDecided?.();
      onChanged?.();
    } catch (failure) {
      setFormError(failure instanceof Error ? failure.message : 'The decision failed');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const latest = useRef({ onBack, form, open, asking, editor, ask, edit, move });
  latest.current = { onBack, form, open, asking, editor, ask, edit, move };
  useKeyboard((key) => {
    const now = latest.current;
    // An editor popup on top reads its own keys, Esc included.
    if (now.editor) return;
    if (key.name === 'escape') {
      // Esc closes the form or the question first; only without one does it leave the mission.
      if (now.form) {
        if (!submitting.current) setForm(undefined);
      } else if (now.asking) {
        if (!submitting.current) setAsking(undefined);
      } else now.onBack();
      return;
    }
    if (now.form) return;
    if (now.asking) {
      if (key.name === 'return') void now.move(now.asking);
      return;
    }
    if (key.name === 'a') return now.open('approve');
    if (key.name === 'r') return now.open('reject');
    const lead = MOVE_ORDER.find((m) => MOVES[m].key === key.name);
    if (lead) return now.ask(lead);
    const editing = (Object.keys(EDITORS) as Editor[]).find((e) => EDITORS[e].key === key.name);
    if (editing) return now.edit(editing);
    const box = scroller.current;
    if (!box) return;
    const page = Math.max(1, box.viewport.height - 1);
    if (key.name === 'down') box.scrollBy(1);
    else if (key.name === 'up') box.scrollBy(-1);
    else if (key.name === 'pagedown') box.scrollBy(page);
    else if (key.name === 'pageup') box.scrollBy(-page);
    else if (key.name === 'home') box.scrollTo(0);
    else if (key.name === 'end') box.scrollTo(box.scrollHeight);
  });

  const button = (action: Decision, label: string) =>
    allowed(action) ? (
      <box key={action} backgroundColor={FORM[action].action} onMouseDown={() => open(action)}>
        <Txt tone="action"> {label} </Txt>
      </box>
    ) : null;

  const buttons = mission
    ? [
        ...MOVE_ORDER.filter(allowed).map((m) => (
          <box
            key={m}
            backgroundColor={MOVES[m].danger ? P.dangerBg : P.buttonBg}
            onMouseDown={() => ask(m)}
          >
            <Txt tone={MOVES[m].danger ? 'action' : 'button'}>
              {' '}
              {MOVES[m].label} ({MOVES[m].key}){' '}
            </Txt>
          </box>
        )),
        ...allowedEdits(mission.allowedActions)
          .filter((e) => e === 'edit' || (e === 'requirements' ? skills : crew))
          .map((e) => (
            <box key={e} backgroundColor={P.buttonBg} onMouseDown={() => edit(e)}>
              <Txt tone="button">
                {' '}
                {EDITORS[e].label} ({EDITORS[e].key}){' '}
              </Txt>
            </box>
          )),
      ]
    : [];

  const shown = mission?.name ?? name;
  const editorProps = mission ? { api, mission, onClose: () => setEditor(undefined) } : undefined;
  return (
    <>
      <Popup title={` ${shown} `} maxWidth={104} maxHeight={30}>
        {outcome ? (
          <box flexShrink={0}>
            <Txt tone={outcome.tone}>{outcome.text}</Txt>
          </box>
        ) : null}
        {error ? (
          <Txt tone="bad">{error}</Txt>
        ) : !mission ? (
          <Txt tone="muted">Loading {name}…</Txt>
        ) : (
          <>
            {!form && !asking && (allowed('approve') || allowed('reject')) ? (
              <box flexDirection="row" gap={2} flexShrink={0}>
                {button('approve', 'Approve (a)')}
                {button('reject', 'Reject (r)')}
              </box>
            ) : null}
            {!form && !asking && buttons.length ? (
              <box flexDirection="row" gap={2} flexShrink={0}>
                {buttons}
              </box>
            ) : null}
            {asking ? (
              <box flexShrink={0} flexDirection="column">
                <Txt tone={moveError ? 'bad' : MOVES[asking].danger ? 'bad' : 'normal'}>
                  {busy ? 'Working…' : `${MOVES[asking].ask} Enter confirm · Esc cancel`}
                </Txt>
                {moveError ? <Txt tone="bad">{moveError}</Txt> : null}
              </box>
            ) : null}
            {form ? (
              <box flexDirection="column" flexShrink={0}>
                <box
                  border
                  borderStyle="rounded"
                  borderColor={FORM[form].color}
                  title={FORM[form].title}
                  titleColor={P.fg}
                  backgroundColor={FIELD.bg}
                  height={3}
                  paddingLeft={1}
                >
                  <input
                    key={form}
                    focused={!busy}
                    textColor={FIELD.fg}
                    backgroundColor={FIELD.bg}
                    focusedBackgroundColor={FIELD.bg}
                    placeholderColor={FIELD.placeholder}
                    placeholder={FORM[form].required ? 'why it is rejected' : 'optional'}
                    onSubmit={(value) => void submit(form, String(value))}
                  />
                </box>
                <Txt tone={formError ? 'bad' : 'muted'}>
                  {busy ? 'Sending…' : (formError ?? 'Enter confirm · Esc cancel')}
                </Txt>
              </box>
            ) : null}
            <scrollbox ref={scroller} flexGrow={1} flexShrink={1} minHeight={0}>
              {missionLines(mission).map((line, index) => (
                <box key={index} flexShrink={0}>
                  <Txt
                    tone={
                      line.tone === 'heading'
                        ? 'accent'
                        : line.tone === 'muted'
                          ? 'muted'
                          : 'normal'
                    }
                  >
                    {line.text || ' '}
                  </Txt>
                </box>
              ))}
            </scrollbox>
          </>
        )}
        <box flexShrink={0}>
          <Txt tone="muted">↑/↓ PgUp/PgDn scroll · Esc close</Txt>
        </box>
      </Popup>
      {editorProps && editor === 'edit' ? (
        <EditMissionPopup {...editorProps} onSaved={(m) => saved(m, 'Saved.')} />
      ) : null}
      {editorProps && editor === 'requirements' && skills ? (
        <RequirementsPopup
          {...editorProps}
          skills={skills}
          onSaved={(m) => saved(m, 'Requirements saved.')}
        />
      ) : null}
      {editorProps && editor === 'crew' && crew ? (
        <CrewPopup {...editorProps} crew={crew} onSaved={(m) => saved(m, 'Crew saved.')} />
      ) : null}
    </>
  );
}
