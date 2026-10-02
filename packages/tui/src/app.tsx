import { useKeyboard, useRenderer } from '@opentui/react';
import type { SessionInfo } from './session.js';

export function App({ session }: { session: SessionInfo }) {
  const renderer = useRenderer();

  useKeyboard((key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) renderer.destroy();
  });

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box border borderStyle="rounded" paddingLeft={1} paddingRight={1}>
        <text>Mission Control</text>
      </box>

      <box flexDirection="column" flexGrow={1} padding={1}>
        <text>API: {session.apiUrl ?? 'not configured (run: mc config set-url <url>)'}</text>
        <text>
          {session.signedIn
            ? `Signed in as ${session.role ?? 'user'} of organisation ${session.orgId ?? '?'}`
            : 'Not signed in (run: mc auth login)'}
        </text>
      </box>

      <box paddingLeft={1}>
        <text>q quit</text>
      </box>
    </box>
  );
}
