import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import { App } from './app.js';
import type { SessionInfo } from './session.js';

const signedOut: SessionInfo = {
  apiUrl: undefined,
  orgId: undefined,
  role: undefined,
  signedIn: false,
};

async function render(session = signedOut) {
  const setup = await testRender(<App session={session} />, { width: 70, height: 12 });
  await setup.renderOnce();
  return setup;
}

describe('App', () => {
  it('shows the title, the key help and how to get started when nothing is configured', async () => {
    const { captureCharFrame, renderer } = await render();
    const frame = captureCharFrame();
    expect(frame).toContain('Mission Control');
    expect(frame).toContain('q quit');
    expect(frame).toContain('mc config set-url');
    expect(frame).toContain('mc auth login');
    renderer.destroy();
  });

  it('shows the API and who is signed in', async () => {
    const { captureCharFrame, renderer } = await render({
      apiUrl: 'http://localhost:3000',
      orgId: 'org-1',
      role: 'lead',
      signedIn: true,
    });
    const frame = captureCharFrame();
    expect(frame).toContain('http://localhost:3000');
    expect(frame).toContain('Signed in as lead of organisation org-1');
    renderer.destroy();
  });

  it('quits on q', async () => {
    const { mockInput, renderer, renderOnce } = await render();
    await mockInput.pressKey('q');
    await renderOnce().catch(() => undefined);
    expect(renderer.isDestroyed).toBe(true);
  });
});
