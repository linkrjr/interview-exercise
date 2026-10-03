import { FIELD, Txt, usePalette } from './theme.js';

export interface FieldFormProps {
  label: string;
  /** What the field starts with, e.g. the current name when renaming. */
  initial?: string;
  placeholder?: string;
  busy: boolean;
  error?: string;
  /** Shown under the field while there is no error. */
  hint: string;
  onSubmit(value: string): void;
}

/** One labelled text field with a hint line, for the small popups: Enter sends what was typed. */
export function FieldForm({
  label,
  initial,
  placeholder,
  busy,
  error,
  hint,
  onSubmit,
}: FieldFormProps) {
  const p = usePalette();
  return (
    <box flexDirection="column" flexShrink={0}>
      <Txt tone="accent">{label}</Txt>
      <box
        border
        borderStyle="rounded"
        borderColor={p.border}
        backgroundColor={FIELD.bg}
        height={3}
        paddingLeft={1}
      >
        <input
          focused={!busy}
          value={initial}
          textColor={FIELD.fg}
          backgroundColor={FIELD.bg}
          focusedBackgroundColor={FIELD.bg}
          placeholderColor={FIELD.placeholder}
          placeholder={placeholder}
          onSubmit={(value) => onSubmit(String(value))}
        />
      </box>
      <Txt tone={error ? 'bad' : 'muted'}>{busy ? 'Saving…' : (error ?? hint)}</Txt>
    </box>
  );
}
