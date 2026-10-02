import { uuidv7 } from 'uuidv7';

/** A new time-ordered UUIDv7 (DESIGN.md §11). */
export function newId(): string {
  return uuidv7();
}
