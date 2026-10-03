import type { User } from '@mc/contracts';
import { useKeyboard } from '@opentui/react';
import { useCallback, useRef, useState } from 'react';
import type { Column } from './data-table.js';
import { InvitePopup } from './invite-popup.js';
import { PagedList } from './paged-list.js';
import { PALETTES, Txt } from './theme.js';

const P = PALETTES.screen;
import { UserPopup } from './user-popup.js';
import type { UsersApi } from './users-api.js';

const COLUMNS: readonly Column<User>[] = [
  { header: 'EMAIL', value: (u) => u.email },
  { header: 'NAME', value: (u) => u.name ?? '-' },
  { header: 'ROLE', value: (u) => u.role },
  { header: 'STATUS', value: (u) => u.status },
];

type Open = { kind: 'user'; user: User } | { kind: 'invite' };

/**
 * Every user of the organisation, with a menu at the bottom to invite another. A row opens that
 * user's popup; both popups sit over the list, which refreshes when one that changed something closes.
 */
export function UsersSection({ api }: { api: UsersApi }) {
  const [open, setOpen] = useState<Open>();
  const [generation, setGeneration] = useState(0);
  const changed = useRef(false);

  const fetchPage = useCallback((cursor: string | undefined) => api.list({ cursor }), [api]);

  const close = () => {
    setOpen(undefined);
    if (changed.current) {
      changed.current = false;
      setGeneration((g) => g + 1);
    }
  };

  useKeyboard((key) => {
    if (!open && key.name === 'i') setOpen({ kind: 'invite' });
  });

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <PagedList
        key={generation}
        fetchPage={fetchPage}
        columns={COLUMNS}
        rowKey={(u) => u.id}
        title="Users"
        emptyText="There are no users yet."
        active={!open}
        onOpen={(user) => setOpen({ kind: 'user', user })}
      />

      <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingTop={1} gap={2}>
        <box backgroundColor={P.buttonBg} onMouseDown={() => !open && setOpen({ kind: 'invite' })}>
          <Txt tone="button"> Invite a user (i) </Txt>
        </box>
      </box>

      {open?.kind === 'user' ? (
        <UserPopup
          api={api}
          user={open.user}
          onClose={close}
          onChanged={() => (changed.current = true)}
        />
      ) : null}
      {open?.kind === 'invite' ? (
        <InvitePopup api={api} onClose={close} onInvited={() => (changed.current = true)} />
      ) : null}
    </box>
  );
}
