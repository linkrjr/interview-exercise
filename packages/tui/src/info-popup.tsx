import { useKeyboard } from '@opentui/react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useRef, useState } from 'react';
import { Popup } from './popup.js';
import { Em, PALETTES, Txt } from './theme.js';

const P = PALETTES.popup;

export interface Fact {
  label: string;
  value: string;
}

/** What an action leaves behind: a message, and the facts as they now are. */
export interface ActionResult {
  message?: string;
  facts?: Fact[];
  /** Extra lines under the buttons, e.g. a new invite code. */
  lines?: string[];
  /** Hides the actions that no longer apply (everything stays if left out). */
  hide?: readonly string[];
}

export interface InfoAction {
  /** The key that runs it, and the button's label. */
  key: string;
  label: string;
  danger?: boolean;
  /** Asks first: Enter confirms, Esc cancels. */
  confirm?: string;
  run(): Promise<ActionResult | void>;
}

export interface InfoPopupProps {
  title: string;
  facts: Fact[];
  /** Free text under the facts (a payload, a description); it scrolls with ↑/↓ when it is long. */
  bodyLines?: string[];
  actions?: readonly InfoAction[];
  maxWidth?: number;
  maxHeight?: number;
  onClose(): void;
  /** Called after an action succeeded, so the list behind can refresh when the popup closes. */
  onChanged?(): void;
}

/**
 * A popup of facts, with actions a person can take on them. Each action has a key and a button,
 * optionally asks first, shows what went wrong in the popup, and can change the facts and hide the
 * actions that no longer apply. Esc closes it (first the question, if one is open).
 */
export function InfoPopup(props: InfoPopupProps) {
  const [facts, setFacts] = useState(props.facts);
  const [hidden, setHidden] = useState<readonly string[]>([]);
  const [confirming, setConfirming] = useState<InfoAction>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'good' | 'bad' }>();
  const [lines, setLines] = useState<string[]>([]);
  const working = useRef(false);
  const scroller = useRef<ScrollBoxRenderable>(null);

  const actions = (props.actions ?? []).filter((a) => !hidden.includes(a.key));

  const run = async (action: InfoAction) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await action.run();
      setConfirming(undefined);
      setLines(result?.lines ?? []);
      if (result?.facts) setFacts(result.facts);
      if (result?.hide) setHidden((h) => [...h, ...result.hide!]);
      if (result?.message) setMessage({ text: result.message, tone: 'good' });
      props.onChanged?.();
    } catch (failure) {
      setMessage({ text: failure instanceof Error ? failure.message : 'That failed', tone: 'bad' });
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const ask = (action: InfoAction) => {
    if (working.current) return;
    if (action.confirm) {
      setMessage(undefined);
      setConfirming(action);
    } else void run(action);
  };

  const latest = useRef({ confirming, actions, ask, run, onClose: props.onClose });
  latest.current = { confirming, actions, ask, run, onClose: props.onClose };
  useKeyboard((key) => {
    const now = latest.current;
    if (key.name === 'escape') {
      if (now.confirming) {
        if (!working.current) setConfirming(undefined);
      } else now.onClose();
    } else if (now.confirming) {
      if (key.name === 'return') void now.run(now.confirming);
    } else {
      const action = now.actions.find((a) => a.key === key.name);
      if (action) return now.ask(action);
      const box = scroller.current;
      if (!box) return;
      const page = Math.max(1, box.viewport.height - 1);
      if (key.name === 'down') box.scrollBy(1);
      else if (key.name === 'up') box.scrollBy(-1);
      else if (key.name === 'pagedown') box.scrollBy(page);
      else if (key.name === 'pageup') box.scrollBy(-page);
      else if (key.name === 'home') box.scrollTo(0);
      else if (key.name === 'end') box.scrollTo(box.scrollHeight);
    }
  });

  const labelWidth = Math.max(9, ...facts.map((f) => f.label.length + 1));
  return (
    <Popup
      title={` ${props.title} `}
      maxWidth={props.maxWidth ?? 92}
      maxHeight={props.maxHeight ?? 16}
    >
      <box flexDirection="column" flexShrink={0}>
        {facts.map((fact) => (
          <Txt key={fact.label}>
            <Em>{fact.label.padEnd(labelWidth)}</Em>
            {fact.value}
          </Txt>
        ))}
      </box>
      {props.bodyLines ? (
        <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} paddingTop={1}>
          <scrollbox ref={scroller} flexGrow={1} flexShrink={1} minHeight={0}>
            {props.bodyLines.map((line, i) => (
              <box key={i} flexShrink={0}>
                <Txt>{line || ' '}</Txt>
              </box>
            ))}
          </scrollbox>
        </box>
      ) : null}
      <box flexDirection="column" flexGrow={props.bodyLines ? 0 : 1} paddingTop={1} flexShrink={0}>
        {message ? <Txt tone={message.tone}>{message.text}</Txt> : null}
        {lines.map((line, i) => (
          <Txt key={i} tone={i === 0 ? 'muted' : 'accent'}>
            {line}
          </Txt>
        ))}
        {confirming ? (
          <Txt tone="bad">
            {busy ? 'Working…' : `${confirming.confirm} Enter confirm · Esc cancel`}
          </Txt>
        ) : (
          <box flexDirection="row" gap={2}>
            {actions.map((action) => (
              <box
                key={action.key}
                backgroundColor={action.danger ? P.dangerBg : P.buttonBg}
                onMouseDown={() => ask(action)}
              >
                <Txt tone={action.danger ? 'action' : 'button'}>
                  {' '}
                  {action.label} ({action.key}){' '}
                </Txt>
              </box>
            ))}
          </box>
        )}
        {busy && !confirming ? <Txt tone="muted">Working…</Txt> : null}
      </box>
      <box flexShrink={0}>
        <Txt tone="muted">Esc close</Txt>
      </box>
    </Popup>
  );
}
