import { getBorderCharacters, table as renderTable } from 'table';
import type { Store } from './store.js';
import type { FetchLike } from './client.js';

export interface Prompts {
  input(message: string): Promise<string>;
  password(message: string): Promise<string>;
}

/** Everything the CLI touches outside itself, so tests can run it in-process. */
export interface CliDeps {
  fetch: FetchLike;
  store: Store;
  env: NodeJS.ProcessEnv;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  /** True when stdin and stdout are terminals: prompts are allowed. */
  interactive: boolean;
  prompts: Prompts;
  readStdin(): Promise<string>;
}

/** Used when the output is not a terminal, or the terminal does not say how wide it is. */
const DEFAULT_WIDTH = 120;
const MIN_COLUMN_WIDTH = 8;
const WIDTH_PER_COLUMN_OVERHEAD = 3; // a border and two spaces of padding

/**
 * Column widths that fit `maxWidth`: every column at the width of its longest line, then the widest
 * shrinkable columns narrowed one character at a time until the table fits. A column never goes
 * below `minimums` (its longest unbreakable word, so ids stay whole and copyable); if that is still
 * too wide the table overflows and the terminal wraps it. Narrowed cells wrap at word boundaries.
 */
export function columnWidths(natural: number[], minimums: number[], maxWidth: number): number[] {
  const widths = [...natural];
  const overhead = widths.length * WIDTH_PER_COLUMN_OVERHEAD + 1;
  while (widths.reduce((a, b) => a + b, 0) + overhead > maxWidth) {
    let target = -1;
    widths.forEach((w, i) => {
      if (w > Math.max(minimums[i]!, MIN_COLUMN_WIDTH) && (target < 0 || w > widths[target]!))
        target = i;
    });
    if (target < 0) break;
    widths[target]! -= 1;
  }
  return widths;
}

const longestLine = (cell: string) => Math.max(0, ...cell.split('\n').map((l) => l.length));
const longestWord = (cell: string) => Math.max(0, ...cell.split(/\s+/).map((w) => w.length));

/**
 * Renders rows as a bordered table with a header row, wrapped to the terminal's width. Plain text:
 * no colour codes, so it reads the same when piped.
 */
export function table(
  headers: string[],
  rows: string[][],
  maxWidth: number = process.stdout.isTTY
    ? (process.stdout.columns ?? DEFAULT_WIDTH)
    : DEFAULT_WIDTH,
): string {
  const natural = headers.map((h, i) =>
    Math.max(longestLine(h), ...rows.map((r) => longestLine(r[i] ?? ''))),
  );
  const minimums = headers.map((h, i) =>
    Math.max(longestWord(h), ...rows.map((r) => longestWord(r[i] ?? ''))),
  );
  const widths = columnWidths(natural, minimums, maxWidth);
  return renderTable([headers, ...rows.map((r) => headers.map((_, i) => r[i] ?? ''))], {
    border: getBorderCharacters('norc'),
    columns: widths.map((width) => ({ width, wrapWord: true })),
    drawHorizontalLine: (index, size) => index === 0 || index === 1 || index === size,
  }).trimEnd();
}
