import { describe, expect, it } from 'vitest';
import { columnWidths, table } from './io.js';

describe('table', () => {
  it('draws a bordered table with a header row', () => {
    expect(
      table(
        ['ID', 'NAME'],
        [
          ['1', 'Ann'],
          ['22', 'Bob'],
        ],
        80,
      ),
    ).toBe(
      [
        '┌────┬──────┐',
        '│ ID │ NAME │',
        '├────┼──────┤',
        '│ 1  │ Ann  │',
        '│ 22 │ Bob  │',
        '└────┴──────┘',
      ].join('\n'),
    );
  });

  it('shows just the header when there are no rows, and fills missing cells', () => {
    expect(table(['A'], [], 80).split('\n')).toHaveLength(3);
    expect(table(['A', 'B'], [['x']], 80)).toContain('│ x │   │');
  });

  it('wraps long text to the width, but never splits an id', () => {
    const id = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0010';
    const out = table(
      ['ID', 'MESSAGE'],
      [[id, 'The scheduler could not process this organisation and will retry on the next run']],
      70,
    );
    expect(out).toContain(id);
    expect(out.split('\n').length).toBeGreaterThan(5);
    expect(Math.max(...out.split('\n').map((l) => l.length))).toBeLessThanOrEqual(70);
  });

  it('overflows rather than breaking a word when nothing can shrink', () => {
    const id = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0010';
    expect(table(['ID'], [[id]], 10)).toContain(id);
  });

  it('keeps multi-line cells and has no colour codes', () => {
    const out = table(['A'], [['one\ntwo']], 80);
    expect(out).toContain('one');
    expect(out).toContain('two');
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe('columnWidths', () => {
  it('leaves a table that fits alone', () => {
    expect(columnWidths([10, 20], [3, 3], 80)).toEqual([10, 20]);
  });
  it('narrows the widest column first and respects the minimums', () => {
    expect(columnWidths([40, 20], [10, 10], 50)).toEqual([23, 20]);
    expect(columnWidths([40, 20], [36, 10], 40)).toEqual([36, 10]);
  });
});
