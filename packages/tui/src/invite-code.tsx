import type { Invite } from '@mc/contracts';
import { useKeyboard, useRenderer } from '@opentui/react';
import { useMemo, useRef, useState } from 'react';
import { createCopy, useClipboardOverride } from './clipboard.js';
import { PALETTES, Txt } from './theme.js';

const P = PALETTES.popup;

/**
 * An invite code, shown once, with a button (and the key `c`) that copies it to the clipboard. If the
 * clipboard cannot be reached it says so; the code stays on screen to select by hand.
 */
export function InviteCode({
  invite,
  label = 'Invite code',
  hint,
}: {
  invite: Invite;
  label?: string;
  hint?: string;
}) {
  const renderer = useRenderer();
  const override = useClipboardOverride();
  const copy = useMemo(() => override ?? createCopy(renderer), [override, renderer]);
  const [copied, setCopied] = useState<boolean>();
  const copying = useRef(false);

  const run = async () => {
    if (copying.current) return;
    copying.current = true;
    try {
      setCopied(await copy(invite.inviteCode));
    } catch {
      setCopied(false);
    } finally {
      copying.current = false;
    }
  };

  const latest = useRef(run);
  latest.current = run;
  useKeyboard((key) => {
    if (key.name === 'c' && !key.ctrl && !key.meta) void latest.current();
  });

  return (
    <box flexDirection="column" flexShrink={0}>
      <Txt tone="muted">
        {label} (shown once, expires {invite.expiresAt}):
      </Txt>
      <Txt tone="accent">{invite.inviteCode}</Txt>
      <box flexDirection="row" gap={2}>
        <box backgroundColor={P.buttonBg} onMouseDown={() => void run()}>
          <Txt tone="button"> Copy (c) </Txt>
        </box>
        {copied === true ? <Txt tone="good">Copied to the clipboard.</Txt> : null}
        {copied === false ? (
          <Txt tone="bad">Could not copy: select the code and copy it by hand.</Txt>
        ) : null}
      </box>
      {hint ? <Txt tone="muted">{hint}</Txt> : null}
    </box>
  );
}
