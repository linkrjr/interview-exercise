/** `2026-10-03T14:07:09.123Z` as `2026-10-03 14:07:09`: the UTC time the API sends, to the second. */
export const time = (iso: string): string =>
  iso
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '')
    .replace(/Z$/, '');

/** An id shortened to its first eight characters, enough to tell rows apart in a table. */
export const shortId = (id: string): string => id.slice(0, 8);

/** A value as readable lines: an object's keys one per line, anything else as it is. */
export function jsonLines(value: unknown): string[] {
  if (value === null || value === undefined) return ['(none)'];
  return JSON.stringify(value, null, 2).split('\n');
}
