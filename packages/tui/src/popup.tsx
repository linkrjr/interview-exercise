import { useTerminalDimensions } from '@opentui/react';
import type { ReactNode } from 'react';
import { PALETTES, SurfaceProvider } from './theme.js';

const P = PALETTES.popup;

/** The rows the screen keeps above and below a popup: header, navigation bar and footer. */
const CHROME_ROWS = 9;

export interface PopupProps {
  title: string;
  /** The widest and tallest the popup gets; it shrinks to fit a smaller terminal. */
  maxWidth: number;
  maxHeight: number;
  borderColor?: string;
  children: ReactNode;
}

/**
 * A bordered box centred over the content area, on top of whatever is already there. The navigation
 * bar stays visible above it. Popups are blue on cyan: they paint an opaque background, so the list shows
 * only around them, and everything inside takes the popup colours.
 */
export function Popup({ title, maxWidth, maxHeight, borderColor, children }: PopupProps) {
  const { width: columns, height: rows } = useTerminalDimensions();
  const width = Math.max(20, Math.min(maxWidth, columns - 4));
  const available = Math.max(6, rows - CHROME_ROWS);
  // Leave at least two rows of the list above and below, so it is visibly still there.
  const height = Math.min(maxHeight, Math.max(6, available - 4));
  return (
    <box
      position="absolute"
      zIndex={10}
      left={Math.max(0, Math.floor((columns - width) / 2))}
      top={Math.max(0, Math.floor((available - height) / 2))}
      width={width}
      height={height}
      border
      borderStyle="rounded"
      borderColor={borderColor ?? P.border}
      title={title}
      titleColor={P.fg}
      backgroundColor={P.bg}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <SurfaceProvider surface="popup">{children}</SurfaceProvider>
    </box>
  );
}
