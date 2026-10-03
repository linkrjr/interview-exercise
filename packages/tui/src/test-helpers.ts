import { act } from 'react';

interface Redrawable {
  renderOnce(): Promise<void>;
}

/**
 * Does something a person would do (press a key, click) inside React's `act`, so the state updates it
 * causes are applied, then redraws. Without `act`, the test renderer leaves them queued.
 */
export async function perform(
  setup: Redrawable,
  action: () => void | Promise<void>,
): Promise<void> {
  await act(async () => {
    await action();
  });
  await setup.renderOnce();
}

/** Lets pending promises (such as an API call the screen made on mount) finish and the screen redraw. */
export async function settle(setup: Redrawable, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await perform(setup, () => new Promise((r) => setTimeout(r, 5)));
}
