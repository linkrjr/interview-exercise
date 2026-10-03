import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useEffect, useRef, type ReactNode } from 'react';
import { PALETTES, Txt } from './theme.js';

const P = PALETTES.screen;
/** A column never goes narrower than this unless its content does. */
const MIN_COLUMN = 6;
/** Each column adds a space on both sides of its text and one border line. */
const PER_COLUMN = 3;

export interface Column<T> {
  header: string;
  value(row: T): string;
}

const cut = (text: string, width: number) =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;

/**
 * Column widths that make the table exactly `total` characters wide, borders and padding included:
 * each column starts at the width of its widest cell (or header). If there is room left over it is
 * shared out in proportion; if there is not enough, the widest columns are narrowed first, down to a
 * readable minimum, and cut with an ellipsis. If even that does not fit, the table overflows.
 */
export function layoutColumns<T>(
  columns: readonly Column<T>[],
  rows: readonly T[],
  total: number,
): number[] {
  const natural = columns.map((column) =>
    Math.max(column.header.length, ...rows.map((row) => column.value(row).length)),
  );
  const room = total - 1 - PER_COLUMN * columns.length;
  const sum = natural.reduce((a, b) => a + b, 0);
  if (sum <= room) {
    // Share the spare room out in proportion to the natural widths; the remainder goes to the widest.
    const widths = natural.map((n) => n + Math.floor(((room - sum) * n) / sum));
    let left = room - widths.reduce((a, b) => a + b, 0);
    const order = natural.map((_, i) => i).sort((a, b) => natural[b]! - natural[a]!);
    for (let i = 0; left > 0; i = (i + 1) % order.length, left--) widths[order[i]!]! += 1;
    return widths;
  }
  const widths = [...natural];
  while (widths.reduce((a, b) => a + b, 0) > room) {
    let target = -1;
    widths.forEach((w, i) => {
      if (w > Math.min(natural[i]!, MIN_COLUMN) && (target < 0 || w > widths[target]!)) target = i;
    });
    if (target < 0) break;
    widths[target]! -= 1;
  }
  return widths;
}

const rule = (widths: number[], left: string, middle: string, right: string, label = '') => {
  const lines = widths.map((w) => '─'.repeat(w + 2));
  const line = `${left}${lines.join(middle)}${right}`;
  if (!label || label.length + 4 > line.length) return line;
  // A label set into the line, ending just before the corner.
  const at = line.length - 2 - label.length - 1;
  return `${line.slice(0, at)} ${label} ${line.slice(at + label.length + 2)}`.replace(
    /(.)$/,
    right,
  );
};

export interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey(row: T): string;
  selected: number;
  onSelectedChange(index: number): void;
  /** Enter, or a click, on a row. */
  onOpen(row: T): void;
  /** Reading keys only while the table is the thing on screen. */
  active: boolean;
  /** Said in the bottom border, e.g. `3/40+`. */
  position?: string;
}

/**
 * A framed table: an outside border, a line between the columns and one under the header. It is as wide
 * as the terminal and runs down to the bottom of the space it is given (empty bordered rows fill what
 * the data does not), so whatever sits above it, such as the navigation bar, stays visible. The header
 * stays put while the rows scroll (↑/↓, PgUp/PgDn, Home/End, the mouse wheel), and the selected row is
 * always kept in view.
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const { columns, rows, selected } = props;
  const { width: screenWidth } = useTerminalDimensions();
  const widths = layoutColumns(columns, rows, Math.max(20, screenWidth - 2));
  const scroller = useRef<ScrollBoxRenderable>(null);

  // Keep the selected row inside the viewport: one row is one line, so row i sits at line i.
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const height = Math.max(1, box.viewport.height);
    if (selected < box.scrollTop) box.scrollTop = selected;
    else if (selected >= box.scrollTop + height) box.scrollTop = selected - height + 1;
  });

  const latest = useRef(props);
  latest.current = props;
  // The selection as of the last key press, which can be ahead of the last render when keys repeat fast.
  const current = useRef(selected);
  current.current = selected;

  useKeyboard((key) => {
    const now = latest.current;
    if (!now.active || now.rows.length === 0) return;
    const page = Math.max(1, (scroller.current?.viewport.height ?? 10) - 1);
    const last = now.rows.length - 1;
    const move = (to: number) => {
      current.current = Math.min(last, Math.max(0, to));
      now.onSelectedChange(current.current);
    };
    if (key.name === 'down') move(current.current + 1);
    else if (key.name === 'up') move(current.current - 1);
    else if (key.name === 'pagedown') move(current.current + page);
    else if (key.name === 'pageup') move(current.current - page);
    else if (key.name === 'home') move(0);
    else if (key.name === 'end') move(last);
    else if (key.name === 'return') {
      const row = now.rows[current.current];
      if (row !== undefined) now.onOpen(row);
    }
  });

  /** The text of one line of cells; the column lines are boxes drawn over it, not characters in it. */
  const line = (texts: string[]) =>
    texts.map((text, i) => ` ${cut(text, widths[i]!).padEnd(widths[i]!)} `).join(' ');
  /** The same with border characters in it, for the fixed header line. */
  const headerCells = (texts: string[]): ReactNode[] => {
    const border = (key: string) => (
      <span key={key} fg={P.border}>
        │
      </span>
    );
    const out: ReactNode[] = [border('b0')];
    texts.forEach((text, i) => {
      out.push(` ${cut(text, widths[i]!).padEnd(widths[i]!)} `, border(`b${i + 1}`));
    });
    return out;
  };
  const frame = (text: string) => (
    <box height={1} flexShrink={0}>
      <text fg={P.border}>{text}</text>
    </box>
  );

  // Where the column lines stand, counted from the left edge of the table: one at each edge and one
  // between the columns.
  const lineAt: number[] = [0];
  widths.forEach((w) => lineAt.push(lineAt[lineAt.length - 1]! + w + 3));
  const tableWidth = lineAt[lineAt.length - 1]! + 1;
  const inner = tableWidth - 2;

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} paddingLeft={1}>
      {frame(rule(widths, '┌', '┬', '┐'))}
      <box height={1} flexShrink={0}>
        <Txt tone="accent">{headerCells(columns.map((c) => c.header))}</Txt>
      </box>
      {frame(rule(widths, '├', '┼', '┤'))}

      {/* The body fills whatever height is left. Its column lines are full-height boxes, so they run
          down to the bottom border whatever the number of rows, with nothing to measure. */}
      <box flexGrow={1} flexShrink={1} minHeight={0} width={tableWidth}>
        <scrollbox
          ref={scroller}
          position="absolute"
          left={1}
          top={0}
          bottom={0}
          width={inner}
          scrollX={false}
          verticalScrollbarOptions={{ visible: false }}
        >
          {rows.map((row, index) => (
            <box
              key={props.rowKey(row)}
              height={1}
              width={inner}
              flexShrink={0}
              backgroundColor={index === selected ? P.selectedBg : undefined}
              onMouseDown={() => {
                if (!props.active) return;
                props.onSelectedChange(index);
                props.onOpen(row);
              }}
            >
              <Txt tone={index === selected ? 'selected' : 'normal'}>
                {line(columns.map((c) => c.value(row)))}
              </Txt>
            </box>
          ))}
        </scrollbox>
        {lineAt.map((x) => (
          <box
            key={x}
            position="absolute"
            zIndex={1}
            left={x}
            top={0}
            bottom={0}
            width={1}
            border={['left']}
            borderStyle="single"
            borderColor={P.border}
          />
        ))}
      </box>
      {frame(rule(widths, '└', '┴', '┘', props.position))}
    </box>
  );
}
