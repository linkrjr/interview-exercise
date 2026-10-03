import { RoleSchema, type InviteUserResponse, type Role } from '@mc/contracts';
import { useKeyboard } from '@opentui/react';
import { useRef, useState } from 'react';
import { InviteCode } from './invite-code.js';
import { Popup } from './popup.js';
import { FIELD, PALETTES, Txt } from './theme.js';

const P = PALETTES.popup;
import { useTextEntry } from './text-entry.js';
import type { UsersApi } from './users-api.js';

const ROLES = RoleSchema.options;
type Field = 'email' | 'role';

export interface InvitePopupProps {
  api: UsersApi;
  onClose(): void;
  /** Called after a user was invited, so the list behind can refresh. */
  onInvited(): void;
}

/**
 * The form to invite a user: an email and a role (the two things the API requires). Tab switches
 * field, ←/→ choose the role, Enter sends. The invite code comes back once, so it is shown here.
 */
export function InvitePopup({ api, onClose, onInvited }: InvitePopupProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('crew');
  const [focus, setFocus] = useState<Field>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<InviteUserResponse>();
  const sending = useRef(false);

  // `q`, the arrow keys and Tab are the form's while it is open.
  useTextEntry(true);

  const submit = async (value: string) => {
    if (sending.current || result) return;
    const address = value.trim();
    if (!address) {
      setError('An email is required');
      setFocus('email');
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      setResult(await api.invite({ email: address, role }));
      onInvited();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The invitation failed');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const latest = useRef({ email, role, focus, onClose, result });
  latest.current = { email, role, focus, onClose, result };
  useKeyboard((key) => {
    const now = latest.current;
    if (key.name === 'escape') return now.onClose();
    if (now.result) return;
    if (key.name === 'tab') setFocus(now.focus === 'email' ? 'role' : 'email');
    else if (now.focus === 'role' && (key.name === 'left' || key.name === 'right')) {
      const step = key.name === 'right' ? 1 : -1;
      const index = ROLES.indexOf(now.role);
      setRole(ROLES[(index + step + ROLES.length) % ROLES.length]!);
    } else if (now.focus === 'role' && key.name === 'return') void submit(now.email);
  });

  return (
    <Popup title=" Invite a user " maxWidth={92} maxHeight={13}>
      {result ? (
        <box flexDirection="column" flexGrow={1}>
          <Txt tone="good">
            Invited {result.user.email} as {result.user.role}.
          </Txt>
          <InviteCode
            invite={result.invite}
            hint="They finish with Accept invite on the sign-in screen, or mc auth accept-invite"
          />
        </box>
      ) : (
        <box flexDirection="column" flexGrow={1}>
          <Txt tone={focus === 'email' ? 'accent' : 'muted'}>Email</Txt>
          <box
            border
            borderStyle="rounded"
            borderColor={focus === 'email' ? P.accent : P.border}
            backgroundColor={FIELD.bg}
            height={3}
            paddingLeft={1}
            flexShrink={0}
            onMouseDown={() => setFocus('email')}
          >
            <input
              focused={focus === 'email' && !busy}
              value={email}
              textColor={FIELD.fg}
              backgroundColor={FIELD.bg}
              focusedBackgroundColor={FIELD.bg}
              placeholderColor={FIELD.placeholder}
              placeholder="person@example.com"
              onInput={setEmail}
              onSubmit={(value) => void submit(String(value))}
            />
          </box>
          <box flexDirection="row" gap={1} onMouseDown={() => setFocus('role')}>
            <Txt tone={focus === 'role' ? 'accent' : 'muted'}>Role</Txt>
            <Txt tone={focus === 'role' ? 'accent' : 'normal'}>
              {focus === 'role' ? '‹' : ' '} {role} {focus === 'role' ? '›' : ' '}
            </Txt>
          </box>
          <Txt tone={error ? 'bad' : 'muted'}>
            {busy ? 'Sending…' : (error ?? 'Tab next field · ←/→ role · Enter invite')}
          </Txt>
        </box>
      )}
      <box flexShrink={0}>
        <Txt tone="muted">Esc {result ? 'close' : 'cancel'}</Txt>
      </box>
    </Popup>
  );
}
