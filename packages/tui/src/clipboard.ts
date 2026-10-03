import { spawn } from 'node:child_process';
import type { CliRenderer } from '@opentui/core';
import { createContext, useContext } from 'react';

/** Puts text on the clipboard; resolves with whether it could. */
export type CopyText = (text: string) => Promise<boolean>;

function pipeTo(command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      child.stdin.on('error', () => resolve(false));
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

/** The system's own clipboard tool, where there is one. Not used over SSH: it would be the remote's. */
async function viaSystemTool(text: string): Promise<boolean> {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  const tools: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];
  for (const [command, args] of tools) if (await pipeTo(command, args, text)) return true;
  return false;
}

/**
 * Copies with the system's clipboard tool when there is one, else asks the terminal to (OSC 52, which
 * most modern terminals honour, also over SSH). Either way the text stays on screen to select by hand.
 */
export function createCopy(renderer: Pick<CliRenderer, 'copyToClipboardOSC52'>): CopyText {
  return async (text) => (await viaSystemTool(text)) || renderer.copyToClipboardOSC52(text);
}

/** Tests provide their own; the app uses the real one (`undefined` means "make it from the renderer"). */
export const ClipboardContext = createContext<CopyText | undefined>(undefined);
export const useClipboardOverride = () => useContext(ClipboardContext);
