import type { Page } from '@mc/contracts';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { Column } from './data-table.js';
import { PagedList } from './paged-list.js';

export interface ListSectionProps<T> {
  fetchPage(cursor: string | undefined): Promise<Page<T>>;
  /** Told when a row's popup opens and closes, for a screen that has keys of its own to hold back. */
  onPopup?(open: boolean): void;
  /** Called after a popup closed (and the list was refreshed, if it had changed something). */
  onClosed?(): void;
  /** True while the screen has a popup of its own open over the list: the list then reads no keys. */
  paused?: boolean;
  columns: readonly Column<T>[];
  rowKey(row: T): string;
  title: string;
  emptyText: string;
  /** The popup of a row. Call `changed()` when it changed something: the list then refreshes on close. */
  renderPopup(args: { row: T; close(): void; changed(): void }): ReactNode;
}

/**
 * A framed table whose rows open a popup. The list stays visible and in place behind it, and is
 * fetched again when a popup that changed something closes.
 */
export function ListSection<T>(props: ListSectionProps<T>) {
  const { fetchPage } = props;
  const [open, setOpen] = useState<T>();
  const [generation, setGeneration] = useState(0);
  const changed = useRef(false);
  const fetch = useCallback((cursor: string | undefined) => fetchPage(cursor), [fetchPage]);

  const close = () => {
    setOpen(undefined);
    props.onPopup?.(false);
    props.onClosed?.();
    if (changed.current) {
      changed.current = false;
      setGeneration((g) => g + 1);
    }
  };

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <PagedList
        key={generation}
        fetchPage={fetch}
        columns={props.columns}
        rowKey={props.rowKey}
        title={props.title}
        emptyText={props.emptyText}
        active={open === undefined && !props.paused}
        onOpen={(row) => {
          setOpen(row);
          props.onPopup?.(true);
        }}
      />
      {open !== undefined
        ? props.renderPopup({ row: open, close, changed: () => (changed.current = true) })
        : null}
    </box>
  );
}
