import { useKeyboard } from '@opentui/react';
import { useRef, useState } from 'react';
import { useTextEntry } from './text-entry.js';
import { FIELD, Txt } from './theme.js';

export interface FieldDef {
  key: string;
  label: string;
  /** `text` is typed; `choice` is picked from `options` with ←/→. */
  kind?: 'text' | 'choice';
  initial?: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
}

export interface FormProps {
  fields: readonly FieldDef[];
  busy: boolean;
  error?: string;
  /** Shown under the fields while there is no error. */
  hint: string;
  /** False leaves the fields unfocused and the keys alone (a form at rest, such as the settings one). */
  active?: boolean;
  labelWidth?: number;
  onSubmit(values: Record<string, string>): void;
}

/**
 * A compact form, one line per field: a label and, beside it, a grey text field or a choice. Tab
 * (Shift+Tab) moves between the fields, ←/→ change a choice, and Enter sends everything. While it is
 * active, `q`, the arrow keys and Tab are the form's and not the screen's.
 */
export function Form({
  fields,
  busy,
  error,
  hint,
  active = true,
  labelWidth = 14,
  onSubmit,
}: FormProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.initial ?? f.options?.[0]?.value ?? ''])),
  );
  const [focus, setFocus] = useState(0);
  useTextEntry(active);

  const latest = useRef({ fields, values, focus, active, busy, onSubmit });
  latest.current = { fields, values, focus, active, busy, onSubmit };

  useKeyboard((key) => {
    const now = latest.current;
    if (!now.active || now.busy) return;
    const field = now.fields[now.focus];
    if (key.name === 'tab') {
      const step = key.shift ? -1 : 1;
      setFocus((now.focus + step + now.fields.length) % now.fields.length);
    } else if (field?.kind === 'choice' && field.options?.length) {
      const index = Math.max(
        0,
        field.options.findIndex((o) => o.value === now.values[field.key]),
      );
      const move = (step: number) =>
        setValues((v) => ({
          ...v,
          [field.key]:
            field.options![(index + step + field.options!.length) % field.options!.length]!.value,
        }));
      if (key.name === 'left') move(-1);
      else if (key.name === 'right') move(1);
      else if (key.name === 'return') now.onSubmit(now.values);
    }
  });

  return (
    <box flexDirection="column" flexShrink={0}>
      {fields.map((field, index) => {
        const focused = active && focus === index;
        return (
          <box
            key={field.key}
            flexDirection="row"
            height={1}
            flexShrink={0}
            onMouseDown={() => setFocus(index)}
          >
            <box width={labelWidth} flexShrink={0}>
              <Txt tone={focused ? 'accent' : 'muted'}>{field.label}</Txt>
            </box>
            <box flexGrow={1} height={1} backgroundColor={FIELD.bg}>
              {field.kind === 'choice' ? (
                <text fg={FIELD.fg}>
                  {` ${focused ? '‹' : ' '} ${
                    field.options?.find((o) => o.value === values[field.key])?.label ?? ''
                  } ${focused ? '›' : ' '}`}
                </text>
              ) : (
                <input
                  focused={focused && !busy}
                  value={field.initial}
                  textColor={FIELD.fg}
                  backgroundColor={FIELD.bg}
                  focusedBackgroundColor={FIELD.bg}
                  placeholderColor={FIELD.placeholder}
                  placeholder={field.placeholder}
                  onInput={(value) => setValues((v) => ({ ...v, [field.key]: value }))}
                  onSubmit={(value) =>
                    onSubmit({ ...latest.current.values, [field.key]: String(value) })
                  }
                />
              )}
            </box>
          </box>
        );
      })}
      <Txt tone={error ? 'bad' : 'muted'}>{busy ? 'Saving…' : (error ?? hint)}</Txt>
    </box>
  );
}
