import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import { useState } from 'react';
import { DataTable, layoutColumns, type Column } from './data-table.js';
import { perform, settle } from './test-helpers.js';

const columns: Column<string[]>[] = [
  { header: 'NAME', value: (r) => r[0]! },
  { header: 'STATUS', value: (r) => r[1]! },
];

describe('layoutColumns', () => {
  it('makes the table exactly as wide as asked, borders and padding included', () => {
    for (const total of [30, 60, 100, 157]) {
      const widths = layoutColumns(
        columns,
        [
          ['alpha', 'ok'],
          ['beta', 'pending'],
        ],
        total,
      );
      // One border at each edge and between the columns, and a space on each side of every cell.
      expect(1 + widths.reduce((sum, w) => sum + w + 3, 0)).toBe(total);
    }
  });

  it('shares spare room in proportion to the content', () => {
    const [a, b] = layoutColumns(columns, [['a'.repeat(30), 'b'.repeat(10)]], 100);
    expect(a! / b!).toBeGreaterThan(2.5);
    expect(a! / b!).toBeLessThan(3.5);
  });

  it('narrows the widest column first when there is not enough room, but not below a minimum', () => {
    const rows = [['x'.repeat(60), 'ok']];
    const [a, b] = layoutColumns(columns, rows, 40);
    expect(b).toBe(6); // the header STATUS keeps its width: it is already at the minimum
    expect(1 + a! + 3 + b! + 3).toBe(40);
    const [c, d] = layoutColumns(columns, [['x'.repeat(60), 'y'.repeat(60)]], 20);
    // Both at the minimum, give or take the one column of slack that fits: it never goes narrower.
    expect(c).toBeGreaterThanOrEqual(6);
    expect(d).toBeGreaterThanOrEqual(6);
    expect(c! + d!).toBeLessThanOrEqual(13);
  });

  it('copes with no rows', () => {
    expect(layoutColumns(columns, [], 50)).toHaveLength(2);
  });
});

async function render(
  rows: string[][],
  options: { width?: number; height?: number; selected?: number } = {},
) {
  const setup = await testRender(
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r[0]!}
      selected={options.selected ?? 0}
      onSelectedChange={() => {}}
      onOpen={() => {}}
      active
      position="1/9"
    />,
    { width: options.width ?? 60, height: options.height ?? 12 },
  );
  await setup.renderOnce();
  await settle(setup);
  await settle(setup);
  return setup;
}

describe('DataTable frame', () => {
  it('has a surrounding border, column borders and a line under the header', async () => {
    const s = await render([
      ['alpha', 'ok'],
      ['beta', 'pending'],
    ]);
    const lines = s
      .captureCharFrame()
      .split('\n')
      .filter((l) => l.trim());
    expect(lines[0]).toMatch(/^ ┌─+┬─+┐ $/);
    expect(lines[1]).toMatch(/^ │ NAME +│ STATUS +│ $/);
    expect(lines[2]).toMatch(/^ ├─+┼─+┤ $/);
    expect(lines[3]).toMatch(/^ │ alpha +│ ok +│ $/);
    expect(lines[4]).toMatch(/^ │ beta +│ pending +│ $/);
    expect(lines.at(-1)).toMatch(/^ └─+┴─+ 1\/9 ┘ $/);
    // Column lines sit under each other all the way down.
    const columnsAt = (line: string) => [...line].flatMap((c, i) => (c === '│' ? [i] : []));
    expect(columnsAt(lines[3]!)).toEqual(columnsAt(lines[1]!));
    expect(columnsAt(lines[4]!)).toEqual(columnsAt(lines[1]!));
    s.renderer.destroy();
  });

  it('takes the whole width: the frame touches both margins at any terminal width', async () => {
    for (const width of [40, 80, 132]) {
      const s = await render([['alpha', 'ok']], { width });
      const top = s
        .captureCharFrame()
        .split('\n')
        .find((l) => l.includes('┌'))!;
      expect(top.indexOf('┌')).toBe(1);
      expect(top.lastIndexOf('┐')).toBe(width - 2);
      s.renderer.destroy();
    }
  });

  it('runs down to the bottom, with empty rows that keep the column lines', async () => {
    const s = await render([['alpha', 'ok']], { height: 14 });
    const lines = s.captureCharFrame().split('\n');
    const top = lines.findIndex((l) => l.includes('┌'));
    const bottom = lines.findIndex((l) => l.includes('└'));
    expect(bottom).toBe(13); // the last line of the screen
    const empty = lines.slice(top + 5, bottom);
    expect(empty.length).toBe(8);
    for (const line of empty) expect(line).toMatch(/^ │ +│ +│ $/);
    s.renderer.destroy();
  });

  it('shows the position in the bottom border', async () => {
    const s = await render([['alpha', 'ok']]);
    expect(s.captureCharFrame()).toContain(' 1/9 ┘');
    s.renderer.destroy();
  });

  it('cuts a long value with an ellipsis rather than breaking the frame', async () => {
    const s = await render([['x'.repeat(80), 'ok']], { width: 40 });
    const lines = s
      .captureCharFrame()
      .split('\n')
      .filter((l) => l.includes('│'));
    expect(lines.some((l) => l.includes('…'))).toBe(true);
    for (const line of lines) expect(line.trimEnd().length).toBeLessThanOrEqual(39);
    s.renderer.destroy();
  });

  it('keeps the frame and header while the rows scroll', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => [`row ${String(i).padStart(2, '0')}`, 'ok']);
    function Controlled() {
      const [selected, setSelected] = useState(0);
      return (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r[0]!}
          selected={selected}
          onSelectedChange={setSelected}
          onOpen={() => {}}
          active
        />
      );
    }
    const setup = await testRender(<Controlled />, { width: 60, height: 12 });
    await setup.renderOnce();
    await settle(setup);
    await perform(setup, () => setup.mockInput.pressKey('END'));
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain('┌');
    expect(frame).toContain('NAME');
    expect(frame).toContain('row 39');
    expect(frame).not.toContain('row 00');
    expect(frame).toContain('└');
    setup.renderer.destroy();
  });
});

describe('DataTable borders and highlight', () => {
  const columnsAt = (line: string) => [...line].flatMap((c, i) => (c === '│' ? [i] : []));

  /** Every line of the body, between the header's line and the bottom border, has the column lines. */
  async function bodyLinesOf(rowCount: number, height = 14) {
    const rows = Array.from({ length: rowCount }, (_, i) => [`row ${i}`, 'ok']);
    // Rendered once and left alone: no key press, no click, nothing that would make it redraw.
    const s = await render(rows, { height });
    const lines = s.captureCharFrame().split('\n');
    const header = lines.findIndex((l) => l.includes('NAME'));
    const bottom = lines.findIndex((l) => l.includes('└'));
    return { s, lines, header, bottom, body: lines.slice(header + 2, bottom) };
  }

  it('shows the whole frame on first paint, whatever the number of rows, selected or not', async () => {
    for (const count of [0, 1, 2, 5]) {
      const { s, lines, header, bottom, body } = await bodyLinesOf(count);
      expect(lines[header - 1], `${count} rows`).toMatch(/^ ┌─+┬─+┐ $/);
      expect(body.length).toBeGreaterThan(5);
      for (const line of body)
        expect(columnsAt(line), `${count} rows`).toEqual(columnsAt(lines[header]!));
      expect(lines[bottom]).toMatch(/^ └─+┴─+ 1\/9 ┘ $/);
      s.renderer.destroy();
    }
  });

  it('draws the column lines down to the bottom border even where there is no row', async () => {
    const { s, body, lines, header } = await bodyLinesOf(1, 20);
    const empty = body.slice(1);
    expect(empty.length).toBe(15);
    for (const line of empty) expect(columnsAt(line)).toEqual(columnsAt(lines[header]!));
    s.renderer.destroy();
  });

  it('keeps the selected row’s highlight between the borders, never past them', async () => {
    const s = await render(
      [
        ['alpha', 'ok'],
        ['beta', 'pending'],
      ],
      { width: 60, selected: 0 },
    );
    const frame = s.captureSpans();
    const lines = s.captureCharFrame().split('\n');
    const y = lines.findIndex((l) => l.includes('alpha'));
    const left = lines[y]!.indexOf('│');
    const right = lines[y]!.lastIndexOf('│');
    const cyan = (x: number) => {
      let at = 0;
      for (const span of frame.lines[y]!.spans) {
        if (x < at + span.width) return span.bg.toInts().slice(0, 3).join(',') === '81,179,180';
        at += span.width;
      }
      return false;
    };
    // The cells between the two outer border lines are highlighted ...
    for (let x = left + 1; x < right; x++) {
      if (lines[y]![x] !== '│') expect(cyan(x), `column ${x}`).toBe(true);
    }
    // ... and nothing outside them is: not the margin, not a cell past the right border.
    expect(cyan(left - 1)).toBe(false);
    expect(cyan(right + 1)).toBe(false);
    expect(cyan(right + 2)).toBe(false);
    // The other row is not highlighted at all.
    const other = lines.findIndex((l) => l.includes('beta'));
    for (let x = left; x <= right; x++) {
      const at = frame.lines[other]!.spans;
      let pos = 0;
      for (const span of at) {
        if (x < pos + span.width) {
          expect(span.bg.toInts().slice(0, 3).join(',')).not.toBe('81,179,180');
          break;
        }
        pos += span.width;
      }
    }
    s.renderer.destroy();
  });
});
