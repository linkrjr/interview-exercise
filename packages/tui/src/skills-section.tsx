import type { Skill } from '@mc/contracts';
import { useKeyboard } from '@opentui/react';
import { useCallback, useRef, useState } from 'react';
import { AddSkillPopup } from './add-skill-popup.js';
import type { Column } from './data-table.js';
import { PagedList } from './paged-list.js';
import { SkillPopup } from './skill-popup.js';
import type { SkillsApi } from './skills-api.js';
import { PALETTES, Txt } from './theme.js';

const P = PALETTES.screen;

const COLUMNS: readonly Column<Skill>[] = [
  { header: 'NAME', value: (s) => s.name },
  { header: 'CREATED', value: (s) => s.createdAt.slice(0, 10) },
];

type Open = { kind: 'skill'; skill: Skill } | { kind: 'add' };

export interface SkillsSectionProps {
  api: SkillsApi;
  /** Directors add and rename skills; everyone else sees the catalogue and nothing to change it with. */
  canManage: boolean;
}

/**
 * The skill catalogue as a table. A row opens that skill's popup; for a Director there is also a menu
 * at the bottom to add a skill. The list refreshes when a popup that changed something closes.
 */
export function SkillsSection({ api, canManage }: SkillsSectionProps) {
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
    if (canManage && !open && key.name === 'a') setOpen({ kind: 'add' });
  });

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <PagedList
        key={generation}
        fetchPage={fetchPage}
        columns={COLUMNS}
        rowKey={(s) => s.id}
        title="Skills"
        emptyText={
          canManage ? 'There are no skills yet: add one below.' : 'There are no skills yet.'
        }
        active={!open}
        onOpen={(skill) => setOpen({ kind: 'skill', skill })}
      />

      {canManage ? (
        <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingTop={1} gap={2}>
          <box backgroundColor={P.buttonBg} onMouseDown={() => !open && setOpen({ kind: 'add' })}>
            <Txt tone="button"> Add a skill (a) </Txt>
          </box>
        </box>
      ) : null}

      {open?.kind === 'skill' ? (
        <SkillPopup
          api={api}
          skill={open.skill}
          canManage={canManage}
          onClose={close}
          onChanged={() => (changed.current = true)}
        />
      ) : null}
      {open?.kind === 'add' ? (
        <AddSkillPopup api={api} onClose={close} onAdded={() => (changed.current = true)} />
      ) : null}
    </box>
  );
}
