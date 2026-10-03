import { useKeyboard } from '@opentui/react';
import { useRef, useState } from 'react';
import type { AcceptInviteInput } from './auth.js';
import { PasswordField } from './password-field.js';
import { FIELD, PALETTES, Txt } from './theme.js';

const P = PALETTES.screen;

type Field = 'code' | 'name' | 'password' | 'confirm' | 'button' | 'back';
const ORDER: Field[] = ['code', 'name', 'password', 'confirm', 'button', 'back'];

export interface AcceptInviteScreenProps {
  /** Accepts the invite and signs in; rejects with an Error whose message is shown. Resolves on success. */
  onAccept: (input: AcceptInviteInput) => Promise<void>;
  /** Back to the sign-in screen. */
  onBack: () => void;
}

/**
 * What `mc auth accept-invite` asks for: the invite code, the person's name and a new password (typed
 * twice). Tab moves on, Enter in a field or on the button sends, Esc (or the last option) goes back.
 */
export function AcceptInviteScreen({ onAccept, onBack }: AcceptInviteScreenProps) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [focus, setFocus] = useState<Field>('code');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const latest = useRef({ code, name, password, confirm, focus, onBack });
  latest.current = { code, name, password, confirm, focus, onBack };
  const submitting = useRef(false);

  const submit = async () => {
    const now = latest.current;
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onAccept({
        code: now.code,
        name: now.name,
        password: now.password,
        confirm: now.confirm,
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Accepting the invite failed');
      setPassword('');
      setConfirm('');
      submitting.current = false;
      setBusy(false);
      setFocus('password');
    }
  };

  useKeyboard((key) => {
    const now = latest.current;
    if (key.name === 'escape') {
      if (!submitting.current) now.onBack();
    } else if (key.name === 'tab') {
      const step = key.shift ? -1 : 1;
      const index = ORDER.indexOf(now.focus);
      setFocus(ORDER[(index + step + ORDER.length) % ORDER.length]!);
    } else if (key.name === 'return') {
      if (now.focus === 'back') now.onBack();
      else if (now.focus !== 'code' && now.focus !== 'name') void submit();
    }
  });

  const field = (name: Field, label: string, child: React.ReactNode) => (
    <box flexDirection="column" flexShrink={0}>
      <Txt tone={focus === name ? 'accent' : 'muted'}>{label}</Txt>
      <box
        border
        borderStyle="rounded"
        borderColor={focus === name ? P.accent : P.border}
        backgroundColor={FIELD.bg}
        height={3}
        paddingLeft={1}
        onMouseDown={() => setFocus(name)}
      >
        {child}
      </box>
    </box>
  );

  const text = (
    name: 'code' | 'name',
    value: string,
    set: (value: string) => void,
    placeholder: string,
  ) => (
    <input
      value={value}
      textColor={FIELD.fg}
      backgroundColor={FIELD.bg}
      focusedBackgroundColor={FIELD.bg}
      placeholderColor={FIELD.placeholder}
      placeholder={placeholder}
      focused={focus === name && !busy}
      onInput={set}
      onSubmit={() => void submit()}
    />
  );

  return (
    <box
      width="100%"
      height="100%"
      alignItems="center"
      justifyContent="center"
      backgroundColor={P.bg}
    >
      <box flexDirection="column" width={56}>
        <box flexDirection="column" alignItems="center" flexShrink={0}>
          <Txt tone="accent">Mission Control</Txt>
          <Txt tone="muted">Accept an invite</Txt>
        </box>

        {field('code', 'Invite code', text('code', code, setCode, 'the code you were given'))}
        {field('name', 'Your name', text('name', name, setName, 'how you appear to others'))}
        {field(
          'password',
          'New password (12 or more characters)',
          <PasswordField
            value={password}
            onChange={setPassword}
            focused={focus === 'password' && !busy}
            placeholder="choose a password"
          />,
        )}
        {field(
          'confirm',
          'Confirm password',
          <PasswordField
            value={confirm}
            onChange={setConfirm}
            focused={focus === 'confirm' && !busy}
            placeholder="type it again"
          />,
        )}

        <box
          border
          borderStyle="rounded"
          borderColor={focus === 'button' ? P.accent : P.border}
          backgroundColor={focus === 'button' ? P.fg : P.buttonBg}
          height={3}
          alignItems="center"
          justifyContent="center"
          flexShrink={0}
          onMouseDown={() => void submit()}
        >
          <Txt tone="button">{busy ? 'Accepting…' : 'Accept invite'}</Txt>
        </box>

        <box alignItems="center" flexShrink={0} onMouseDown={() => !submitting.current && onBack()}>
          <Txt tone={focus === 'back' ? 'accent' : 'muted'}>
            {focus === 'back' ? '› Back to sign in ‹' : 'Back to sign in'}
          </Txt>
        </box>

        {error ? <Txt tone="bad">{error}</Txt> : null}
        <Txt tone="muted">Tab next field · Enter accept · Esc back · Ctrl+C quit</Txt>
      </box>
    </box>
  );
}
