import { useKeyboard } from '@opentui/react';
import { useRef, useState } from 'react';
import type { Apis } from './apis.js';
import { navigationFor, SIGN_OUT } from './navigation.js';
import { SectionBody } from './sections.js';
import type { SessionInfo } from './session.js';
import { useIsTextEntryActive } from './text-entry.js';
import { PALETTES, Txt } from './theme.js';

const P = PALETTES.screen;

export interface MainScreenProps {
  session: SessionInfo;
  apis: Apis;
  onSignOut: () => Promise<void>;
}

/** The screen after a successful login: a navigation bar with what this role can do, and its section. */
export function MainScreen({ session, apis, onSignOut }: MainScreenProps) {
  const items = navigationFor(session.role);
  const [selected, setSelected] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const current = items[selected] ?? items[0]!;

  const latest = useRef({ selected, count: items.length, id: current.id });
  latest.current = { selected, count: items.length, id: current.id };
  const leaving = useRef(false);

  const signOut = async () => {
    if (leaving.current) return;
    leaving.current = true;
    setSigningOut(true);
    await onSignOut();
  };

  const typing = useIsTextEntryActive();
  useKeyboard((key) => {
    // Arrow keys and Tab belong to the text field while someone is typing in one.
    if (typing()) return;
    const now = latest.current;
    const step =
      key.name === 'right' || (key.name === 'tab' && !key.shift)
        ? 1
        : key.name === 'left' || (key.name === 'tab' && key.shift)
          ? -1
          : 0;
    if (step !== 0) setSelected((now.selected + step + now.count) % now.count);
    else if (key.name === 'return' && now.id === SIGN_OUT.id) void signOut();
  });

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={P.bg}>
      <box
        border
        borderStyle="rounded"
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
      >
        <Txt tone="accent">Mission Control</Txt>
        <Txt tone="muted">
          {session.role ?? 'user'} · {session.orgId ?? ''}
        </Txt>
      </box>

      <box flexDirection="row" flexWrap="wrap" flexShrink={0} paddingLeft={1} gap={2} rowGap={0}>
        {items.map((item, index) => (
          <box
            key={item.id}
            onMouseDown={() => setSelected(index)}
            backgroundColor={index === selected ? P.selectedBg : undefined}
          >
            <Txt tone={index === selected ? 'selected' : 'normal'}> {item.label} </Txt>
          </box>
        ))}
      </box>

      {current.id === SIGN_OUT.id ? (
        <box flexDirection="column" flexGrow={1} padding={1} gap={1}>
          <Txt tone="accent">{current.label}</Txt>
          <Txt>{current.summary}</Txt>
          <box
            border
            borderStyle="rounded"
            borderColor={P.border}
            backgroundColor={P.buttonBg}
            width={20}
            height={3}
            alignItems="center"
            justifyContent="center"
            onMouseDown={() => void signOut()}
          >
            <Txt tone="button">{signingOut ? 'Signing out…' : 'Sign out (Enter)'}</Txt>
          </box>
        </box>
      ) : (
        // Keyed by section, so choosing it again always starts from fresh data.
        <SectionBody key={current.id} item={current} apis={apis} session={session} />
      )}

      <box paddingLeft={1} flexShrink={0}>
        <Txt tone="muted">
          ←/→ or Tab section · ↑/↓ PgUp/PgDn rows · Enter open · Esc close · q quit
        </Txt>
      </box>
    </box>
  );
}
