/**
 * "Today" as a `YYYY-MM-DD` date in an IANA time zone (DESIGN.md OQ-9). Dates in this system are
 * plain days, compared as strings.
 */
export function todayIn(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
