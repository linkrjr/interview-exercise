import { decodePasteBytes } from '@opentui/core';
import { useKeyboard, usePaste } from '@opentui/react';
import { FIELD } from './theme.js';

const MASK = '•';

/** A printable character: one code point, no Ctrl or Meta, not a control character or DEL. */
function printable(key: { sequence: string; ctrl: boolean; meta: boolean }): string | undefined {
  const { sequence } = key;
  if (key.ctrl || key.meta || [...sequence].length !== 1) return undefined;
  return sequence >= ' ' && sequence !== '\x7f' ? sequence : undefined;
}

/**
 * A single-line password entry that never shows what is typed (OpenTUI's `<input>` cannot mask).
 * It reads the keyboard itself while `focused`: characters append, Backspace deletes, Ctrl+U clears,
 * and pasted text is appended without its line breaks.
 */
export function PasswordField(props: {
  value: string;
  /** Takes an update function, so fast typing and paste never work from a stale value. */
  onChange: (update: (previous: string) => string) => void;
  focused: boolean;
  placeholder?: string;
}) {
  const { value, onChange, focused } = props;

  useKeyboard((key) => {
    if (!focused) return;
    if (key.name === 'backspace') onChange((previous) => [...previous].slice(0, -1).join(''));
    else if (key.ctrl && key.name === 'u') onChange(() => '');
    else {
      const typed = printable(key);
      if (typed) onChange((previous) => previous + typed);
    }
  });

  usePaste((event) => {
    if (!focused) return;
    const pasted = decodePasteBytes(event.bytes).replace(/[\r\n]/g, '');
    onChange((previous) => previous + pasted);
  });

  const shown = MASK.repeat([...value].length);
  return (
    <text fg={value.length === 0 && !focused ? FIELD.placeholder : FIELD.fg}>
      {value.length === 0 && !focused ? (props.placeholder ?? '') : `${shown}${focused ? '█' : ''}`}
    </text>
  );
}
