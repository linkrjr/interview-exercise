import { createContext, useContext, type ReactNode } from 'react';

/**
 * The colours of the old Clipper programs (docs/tui.spec.md, "Color Styles"): white on blue for the
 * screens and lists, blue on cyan for popups, black on grey for form fields. Everything the spec
 * does not name (selection, buttons, errors, muted text) is derived from these and picked to stay
 * readable on each background.
 */
const BLUE = '#0A00B2'; // R10 G0 B178
const CYAN = '#51B3B4'; // R81 G179 B180
const GREY = '#B2B4B1'; // R178 G180 B177
const WHITE = '#FFFFFF';
const BLACK = '#000000';

export type Surface = 'screen' | 'popup';

export interface Palette {
  /** The background and the text on it. */
  bg: string;
  fg: string;
  /** Secondary text, headings, errors and successes. */
  muted: string;
  accent: string;
  bad: string;
  good: string;
  /** Borders. */
  border: string;
  /** The selected row or item (inverse video, as in Clipper). */
  selectedBg: string;
  selectedFg: string;
  /** Buttons, and the two that act on someone: one that confirms and one that is destructive. */
  buttonBg: string;
  buttonFg: string;
  successBg: string;
  dangerBg: string;
  actionFg: string;
}

export const PALETTES: Record<Surface, Palette> = {
  screen: {
    bg: BLUE,
    fg: WHITE,
    muted: GREY,
    accent: '#FFFF55',
    bad: '#FF8080',
    good: '#55FF55',
    border: WHITE,
    selectedBg: CYAN,
    selectedFg: BLUE,
    buttonBg: CYAN,
    buttonFg: BLUE,
    successBg: '#006400',
    dangerBg: '#AA0000',
    actionFg: WHITE,
  },
  popup: {
    bg: CYAN,
    fg: BLUE,
    muted: '#2A2A8A',
    accent: BLACK,
    bad: '#8B0000',
    good: '#004D00',
    border: BLUE,
    selectedBg: BLUE,
    selectedFg: WHITE,
    buttonBg: BLUE,
    buttonFg: WHITE,
    successBg: '#006400',
    dangerBg: '#8B0000',
    actionFg: WHITE,
  },
};

/** Form fields look the same everywhere. */
export const FIELD = { bg: GREY, fg: BLACK, placeholder: '#555555' } as const;

const SurfaceContext = createContext<Surface>('screen');

/** Everything inside takes the colours of this surface. */
export function SurfaceProvider({ surface, children }: { surface: Surface; children: ReactNode }) {
  return <SurfaceContext.Provider value={surface}>{children}</SurfaceContext.Provider>;
}

export const usePalette = (): Palette => PALETTES[useContext(SurfaceContext)];

export type Tone =
  'normal' | 'muted' | 'accent' | 'bad' | 'good' | 'selected' | 'button' | 'action' | 'field';

/** Text in the colours of its surface; `tone` says what the text is. */
export function Txt({ tone = 'normal', children }: { tone?: Tone; children?: ReactNode }) {
  const p = usePalette();
  const color: Record<Tone, string> = {
    normal: p.fg,
    muted: p.muted,
    accent: p.accent,
    bad: p.bad,
    good: p.good,
    selected: p.selectedFg,
    button: p.buttonFg,
    action: p.actionFg,
    field: FIELD.fg,
  };
  return <text fg={color[tone]}>{children}</text>;
}

/** The span of a differently coloured word inside a `Txt`. */
export function Em({ children }: { children: ReactNode }) {
  const p = usePalette();
  return <span fg={p.muted}>{children}</span>;
}
