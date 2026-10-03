import type { Invite, User } from '@mc/contracts';
import { useKeyboard } from '@opentui/react';
import { useRef, useState } from 'react';
import { InviteCode } from './invite-code.js';
import { Popup } from './popup.js';
import { Em, PALETTES, Txt } from './theme.js';

const P = PALETTES.popup;
import type { UsersApi } from './users-api.js';

type Action = 'deactivate' | 'reinvite';

export interface UserPopupProps {
  api: UsersApi;
  user: User;
  onClose(): void;
  /** Called after the user was changed, so the list it came from can refresh. */
  onChanged(): void;
}

/** Whether each action applies: nobody comes back from deactivated, and only a pending invitee can be reinvited. */
export const canDeactivate = (user: User) => user.status !== 'deactivated';
export const canReinvite = (user: User) => user.status === 'invited';

/**
 * The main facts about one user (no missions, no skills) and what a Director can do about them:
 * Deactivate (after a confirmation) and, for someone who has not accepted yet, Reinvite, which shows
 * the new invite code once.
 */
export function UserPopup({ api, user: initial, onClose, onChanged }: UserPopupProps) {
  const [user, setUser] = useState(initial);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'good' | 'bad' }>();
  const [invite, setInvite] = useState<Invite>();
  const working = useRef(false);

  const run = async (work: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setMessage(undefined);
    try {
      await work();
    } catch (failure) {
      setMessage({ text: failure instanceof Error ? failure.message : 'That failed', tone: 'bad' });
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const ask = (action: Action) => {
    if (working.current) return;
    if (action === 'deactivate' && canDeactivate(user)) {
      setMessage(undefined);
      setInvite(undefined);
      setConfirming(true);
    } else if (action === 'reinvite' && canReinvite(user)) {
      setConfirming(false);
      void run(async () => {
        setInvite(await api.reinvite(user.id));
        onChanged();
      });
    }
  };

  const confirmDeactivate = () =>
    run(async () => {
      setUser(await api.deactivate(user.id));
      setConfirming(false);
      setInvite(undefined);
      setMessage({ text: 'Deactivated.', tone: 'good' });
      onChanged();
    });

  const latest = useRef({ confirming, onClose, ask, confirmDeactivate });
  latest.current = { confirming, onClose, ask, confirmDeactivate };
  useKeyboard((key) => {
    const now = latest.current;
    if (key.name === 'escape') {
      if (now.confirming) {
        if (!working.current) setConfirming(false);
      } else now.onClose();
    } else if (now.confirming) {
      if (key.name === 'return') void now.confirmDeactivate();
    } else if (key.name === 'd') now.ask('deactivate');
    else if (key.name === 'r') now.ask('reinvite');
  });

  const fact = (label: string, value: string) => (
    <Txt>
      <Em>{label.padEnd(9)}</Em>
      {value}
    </Txt>
  );
  const button = (action: Action, label: string, color: string) => (
    <box key={action} backgroundColor={color} onMouseDown={() => ask(action)}>
      <Txt tone="action"> {label} </Txt>
    </box>
  );

  return (
    <Popup title={` ${user.name ?? user.email} `} maxWidth={92} maxHeight={16}>
      <box flexDirection="column" flexShrink={0}>
        {fact('Name', user.name ?? '(has not accepted the invite yet)')}
        {fact('Email', user.email)}
        {fact('Role', user.role)}
        {fact('Status', user.status)}
        {fact('Created', user.createdAt)}
        {fact('Id', user.id)}
      </box>

      <box flexDirection="column" flexGrow={1} paddingTop={1}>
        {message ? <Txt tone={message.tone}>{message.text}</Txt> : null}
        {invite ? <InviteCode invite={invite} label="New invite code" /> : null}
        {confirming ? (
          <Txt tone="bad">
            {busy ? 'Deactivating…' : `Deactivate ${user.email}? Enter confirm · Esc cancel`}
          </Txt>
        ) : (
          <box flexDirection="row" gap={2}>
            {canDeactivate(user) ? button('deactivate', 'Deactivate (d)', P.dangerBg) : null}
            {canReinvite(user) ? button('reinvite', 'Reinvite (r)', P.buttonBg) : null}
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
