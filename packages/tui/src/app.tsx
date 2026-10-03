import { useKeyboard, useRenderer } from '@opentui/react';
import { useRef, useState } from 'react';
import { AcceptInviteScreen } from './accept-invite-screen.js';
import type { AcceptInviteInput, LoginInput } from './auth.js';
import type { Apis } from './apis.js';
import { LoginScreen } from './login-screen.js';
import { MainScreen } from './main-screen.js';
import type { SessionInfo } from './session.js';
import { TextEntryContext } from './text-entry.js';

export interface AppProps {
  session: SessionInfo;
  /** Everything the screens read from the API. */
  apis: Apis;
  /** Signs in with the CLI's flow and stores the session; resolves with the new session details. */
  onLogin: (input: LoginInput) => Promise<SessionInfo>;
  /** Accepts an invite like `mc auth accept-invite` and stores the session it returns. */
  onAcceptInvite: (input: AcceptInviteInput) => Promise<SessionInfo>;
  /** Signs out like `mc auth logout`; resolves with the (now signed-out) session. */
  onSignOut: () => Promise<SessionInfo>;
}

export function App(props: AppProps) {
  const renderer = useRenderer();
  const [session, setSession] = useState(props.session);
  const [accepting, setAccepting] = useState(false);
  const textEntry = useRef({ active: { current: false } }).current;

  useKeyboard((key) => {
    // `q` quits only where it cannot be part of what is being typed.
    if (
      (key.ctrl && key.name === 'c') ||
      (session.signedIn && key.name === 'q' && !textEntry.active.current)
    )
      renderer.destroy();
  });

  if (!session.signedIn && accepting) {
    return (
      <AcceptInviteScreen
        onAccept={async (input) => {
          setSession(await props.onAcceptInvite(input));
          setAccepting(false);
        }}
        onBack={() => setAccepting(false)}
      />
    );
  }

  if (!session.signedIn) {
    return (
      <LoginScreen
        initialOrgId={session.orgId}
        onLogin={async (input) => setSession(await props.onLogin(input))}
        onAcceptInvite={() => setAccepting(true)}
      />
    );
  }

  return (
    <TextEntryContext.Provider value={textEntry}>
      <MainScreen
        session={session}
        apis={props.apis}
        onSignOut={async () => setSession(await props.onSignOut())}
      />
    </TextEntryContext.Provider>
  );
}
