import type { Page } from '@mc/contracts';
import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DataTable, type Column } from './data-table.js';
import { Txt } from './theme.js';

/** Fetch the next page when the selection is this close to the last loaded row. */
const LOOKAHEAD = 5;

export interface PagedListProps<T> {
  /** Fetches one page. Pass a stable function: a new one reloads the list. */
  fetchPage(cursor: string | undefined): Promise<Page<T>>;
  columns: readonly Column<T>[];
  rowKey(row: T): string;
  title: string;
  emptyText: string;
  /** False while a popup is open on top of the list: it keeps its place but reads no keys or clicks. */
  active: boolean;
  onOpen(row: T): void;
}

/** A scrollable, selectable table fetched a page at a time as the end is reached. */
export function PagedList<T>(props: PagedListProps<T>) {
  const { fetchPage } = props;
  const [rows, setRows] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState(0);
  const loadingRef = useRef(false);

  const load = useCallback(
    async (after: string | undefined) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      setError(undefined);
      try {
        const page = await fetchPage(after);
        setRows((previous) => (after ? [...previous, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Could not load the list');
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    void load(undefined);
  }, [load]);

  const select = (index: number) => {
    setSelected(index);
    if (cursor && index >= rows.length - LOOKAHEAD) void load(cursor);
  };

  useKeyboard((key) => {
    if (props.active && key.name === 'r' && !loading) {
      setSelected(0);
      void load(undefined);
    }
  });

  // Each state has its own key: the renderer keeps a box's old padding when a reused box loses the prop,
  // which would push the table one cell down and to the right.
  if (error && rows.length === 0) {
    return (
      <box key="error" flexDirection="column" padding={1}>
        <Txt tone="bad">{error}</Txt>
        <Txt tone="muted">r to try again</Txt>
      </box>
    );
  }
  if (loading && rows.length === 0) {
    return (
      <box key="loading" padding={1}>
        <Txt tone="muted">Loading…</Txt>
      </box>
    );
  }
  if (rows.length === 0) {
    return (
      <box key="empty" padding={1}>
        <Txt>{props.emptyText}</Txt>
      </box>
    );
  }

  return (
    <box key="table" flexDirection="column" flexGrow={1} minHeight={0}>
      <box paddingLeft={1} paddingTop={1} flexShrink={0}>
        <Txt>
          {props.title}: {rows.length}
          {cursor ? '+' : ''}
          {loading ? '  loading more…' : ''}
        </Txt>
      </box>
      <DataTable
        columns={props.columns}
        rows={rows}
        rowKey={props.rowKey}
        selected={selected}
        onSelectedChange={select}
        onOpen={props.onOpen}
        active={props.active}
        position={`${selected + 1}/${rows.length}${cursor ? '+' : ''}`}
      />
      {error ? (
        <box paddingLeft={1} flexShrink={0}>
          <Txt tone="bad">{error} (r to reload)</Txt>
        </box>
      ) : null}
    </box>
  );
}
