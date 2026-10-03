import { createContext, useContext, useEffect, type MutableRefObject } from 'react';

/**
 * Whether a text field is being typed into. Keys such as `q` (quit) and the arrow keys (change
 * section) mean something everywhere else, but not while someone is writing a comment, so the
 * screens that act on them check this first.
 */
export interface TextEntry {
  active: MutableRefObject<boolean>;
}

export const TextEntryContext = createContext<TextEntry>({ active: { current: false } });

/** Marks text entry as active for as long as `active` is true. */
export function useTextEntry(active: boolean): void {
  const entry = useContext(TextEntryContext);
  useEffect(() => {
    entry.active.current = active;
    return () => {
      entry.active.current = false;
    };
  }, [entry, active]);
}

/** Reads whether text is being entered, at the moment a key arrives. */
export function useIsTextEntryActive(): () => boolean {
  const entry = useContext(TextEntryContext);
  return () => entry.active.current;
}
