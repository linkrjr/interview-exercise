import { z } from 'zod';

/**
 * True for an IANA time zone name the runtime knows (e.g. `Europe/London`, `UTC`). UTC offsets
 * such as `+01:00`, which `Intl` also accepts, are not IANA names and are rejected.
 */
export function isIanaTimeZone(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const TimeZoneSchema = z
  .string()
  .trim()
  .refine(isIanaTimeZone, { message: 'Not a valid IANA time zone, e.g. Europe/London' });
