import { useKeyboard } from '@opentui/react';
import { useRef, useState } from 'react';
import { Form, type FieldDef } from './form.js';
import { Popup } from './popup.js';
import { Txt } from './theme.js';

export interface FormPopupProps {
  title: string;
  fields: readonly FieldDef[];
  hint?: string;
  /**
   * Sends what was entered. Throw an Error to show its message in the form and keep it open. Returning
   * a message keeps the popup open to show it; returning nothing closes the popup.
   */
  onSubmit(values: Record<string, string>): Promise<string | void>;
  onClose(): void;
  /** Called after a submission succeeded, so the list behind can refresh when the popup closes. */
  onChanged?(): void;
  maxWidth?: number;
  labelWidth?: number;
}

/** A popup around a {@link Form}: Enter sends, Esc cancels (or closes, once it has said it is done). */
export function FormPopup(props: FormPopupProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const sending = useRef(false);

  const submit = async (values: Record<string, string>) => {
    if (sending.current || done) return;
    sending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const message = await props.onSubmit(values);
      props.onChanged?.();
      if (message) setDone(message);
      else props.onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That failed');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const close = useRef(props.onClose);
  close.current = props.onClose;
  useKeyboard((key) => {
    if (key.name === 'escape') close.current();
  });

  return (
    <Popup
      title={` ${props.title} `}
      maxWidth={props.maxWidth ?? 72}
      maxHeight={props.fields.length + 8}
    >
      <box flexDirection="column" flexGrow={1}>
        {done ? (
          <Txt tone="good">{done}</Txt>
        ) : (
          <Form
            fields={props.fields}
            busy={busy}
            error={error}
            hint={props.hint ?? 'Tab next field · Enter save · Esc cancel'}
            labelWidth={props.labelWidth}
            onSubmit={(values) => void submit(values)}
          />
        )}
      </box>
      <box flexShrink={0}>
        <Txt tone="muted">Esc {done ? 'close' : 'cancel'}</Txt>
      </box>
    </Popup>
  );
}
