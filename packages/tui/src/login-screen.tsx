import { useKeyboard } from '@opentui/react';
import { useRef, useState } from 'react';
import type { LoginInput } from './auth.js';
import { PasswordField } from './password-field.js';
import { FIELD, PALETTES, Txt } from './theme.js';

const P = PALETTES.screen;

type Field = 'email' | 'org' | 'password' | 'button' | 'invite';
const ORDER: Field[] = ['email', 'org', 'password', 'button', 'invite'];

export interface LoginScreenProps {
  /** The organisation to start with: the CLI remembers it after the first sign-in. */
  initialOrgId?: string;
  /** Signs in; rejects with an Error whose message is shown to the person. Resolves on success. */
  onLogin: (input: LoginInput) => Promise<void>;
  /** Opens the screen for accepting an invite. */
  onAcceptInvite: () => void;
}

export function LoginScreen({ initialOrgId = '', onLogin, onAcceptInvite }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [org, setOrg] = useState(initialOrgId);
  const [password, setPassword] = useState('');
  const [focus, setFocus] = useState<Field>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // The key handlers outlive a render, so they read the latest values through a ref.
  const latest = useRef({ email, org, password, focus, onAcceptInvite });
  latest.current = { email, org, password, focus, onAcceptInvite };
  // Set at once, not on the next render: a second Enter can arrive before the screen redraws.
  const submitting = useRef(false);

  const submit = async () => {
    const now = latest.current;
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onLogin({ email: now.email, orgId: now.org, password: now.password });
      // Success hands over to the next screen; this one goes away.
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Sign-in failed');
      setPassword('');
      submitting.current = false;
      setBusy(false);
      setFocus('password');
    }
  };

  useKeyboard((key) => {
    const now = latest.current;
    if (key.name === 'tab') {
      const step = key.shift ? -1 : 1;
      const index = ORDER.indexOf(now.focus);
      setFocus(ORDER[(index + step + ORDER.length) % ORDER.length]!);
    } else if (key.name === 'return' && (now.focus === 'password' || now.focus === 'button')) {
      void submit();
    } else if (key.name === 'return' && now.focus === 'invite') {
      now.onAcceptInvite();
    }
  });

  const field = (name: Field, label: string, child: React.ReactNode) => (
    <box flexDirection="column">
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

  return (
    <box
      width="100%"
      height="100%"
      alignItems="center"
      justifyContent="center"
      backgroundColor={P.bg}
    >
      <box flexDirection="column" width={56} gap={1}>
        <box flexDirection="column" alignItems="center">
          <Txt tone="accent">Mission Control</Txt>
          <Txt tone="muted">Sign in</Txt>
        </box>

        {field(
          'email',
          'Email',
          <input
            value={email}
            textColor={FIELD.fg}
            backgroundColor={FIELD.bg}
            focusedBackgroundColor={FIELD.bg}
            placeholderColor={FIELD.placeholder}
            placeholder="you@example.com"
            focused={focus === 'email' && !busy}
            onInput={setEmail}
            onSubmit={() => void submit()}
          />,
        )}
        {field(
          'org',
          'Organisation',
          <input
            value={org}
            textColor={FIELD.fg}
            backgroundColor={FIELD.bg}
            focusedBackgroundColor={FIELD.bg}
            placeholderColor={FIELD.placeholder}
            placeholder="organisation id"
            focused={focus === 'org' && !busy}
            onInput={setOrg}
            onSubmit={() => void submit()}
          />,
        )}
        {field(
          'password',
          'Password',
          <PasswordField
            value={password}
            onChange={setPassword}
            focused={focus === 'password' && !busy}
            placeholder="password"
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
          onMouseDown={() => void submit()}
        >
          <Txt tone="button">{busy ? 'Signing in…' : 'Login'}</Txt>
        </box>

        <box
          alignItems="center"
          flexShrink={0}
          onMouseDown={() => !submitting.current && onAcceptInvite()}
        >
          <Txt tone={focus === 'invite' ? 'accent' : 'muted'}>
            {focus === 'invite' ? '› Accept invite ‹' : 'Accept invite'}
          </Txt>
        </box>

        {error ? <Txt tone="bad">{error}</Txt> : null}
        <Txt tone="muted">Tab next field · Enter sign in · Ctrl+C quit</Txt>
      </box>
    </box>
  );
}
