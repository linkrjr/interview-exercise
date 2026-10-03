import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import { App } from './app.js';
import {
  fakeApis,
  fakeApi,
  fakeSettingsApi,
  fakeSkillsApi,
  fakeUsersApi,
  mission,
  pageOf,
  summary,
} from './fixtures.js';
import type { LoginInput } from './auth.js';
import type { SessionInfo } from './session.js';
import { perform, settle } from './test-helpers.js';

const signedOut: SessionInfo = {
  apiUrl: undefined,
  orgId: undefined,
  role: undefined,
  signedIn: false,
};
const signedIn: SessionInfo = {
  apiUrl: 'http://localhost:3000',
  orgId: 'org-1',
  role: 'lead',
  signedIn: true,
};
const never = async (): Promise<SessionInfo> => signedIn;
const afterSignOut = async (): Promise<SessionInfo> => ({ ...signedOut, orgId: 'org-1' });

async function render(
  session: SessionInfo,
  onLogin: (input: LoginInput) => Promise<SessionInfo> = never,
  onSignOut: () => Promise<SessionInfo> = afterSignOut,
) {
  const setup = await testRender(
    <App
      session={session}
      apis={fakeApis({
        missions: fakeApi([pageOf([])]),
        users: fakeUsersApi(),
        skills: fakeSkillsApi(),
        settings: fakeSettingsApi(),
      })}
      onLogin={onLogin}
      onAcceptInvite={() => Promise.reject(new Error('unused'))}
      onSignOut={onSignOut}
    />,
    { width: 100, height: 36 },
  );
  await setup.renderOnce();
  return setup;
}

describe('App when signed in', () => {
  it('shows the main screen with the navigation bar of the role, and quits on q', async () => {
    const setup = await render(signedIn);
    const frame = setup.captureCharFrame();
    expect(frame).toContain('lead · org-1');
    expect(frame).toContain('New mission');
    expect(frame).not.toContain('Approvals');
    expect(frame).not.toContain('Login');
    await perform(setup, () => setup.mockInput.pressKey('q')).catch(() => undefined);
    expect(setup.renderer.isDestroyed).toBe(true);
  });
});

describe('App when signed out', () => {
  it('shows the login screen', async () => {
    const { captureCharFrame, renderer } = await render(signedOut);
    const frame = captureCharFrame();
    for (const text of ['Sign in', 'Email', 'Organisation', 'Password', 'Login']) {
      expect(frame).toContain(text);
    }
    renderer.destroy();
  });

  it('moves to the main screen once the login succeeds, with the bar of the signed-in role', async () => {
    const setup = await render(signedOut, async () => ({ ...signedIn, role: 'crew' }));
    const { mockInput, waitForFrame, renderer } = setup;
    for (const step of ['lee@example.com', 'org-1', 'secret']) {
      await perform(setup, () => mockInput.typeText(step));
      if (step !== 'secret') await perform(setup, () => mockInput.pressTab());
    }
    await perform(setup, () => mockInput.pressEnter());
    const frame = await waitForFrame((f) => f.includes('My assignments'));
    expect(frame).not.toContain('Login');
    expect(frame).not.toContain('New mission');

    // On the main screen q quits, though the app started out on the login screen.
    await perform(setup, () => mockInput.pressKey('q')).catch(() => undefined);
    expect(renderer.isDestroyed).toBe(true);
  });

  it('does not quit on q, which belongs to what is being typed, but quits on Ctrl+C', async () => {
    const setup = await render(signedOut);
    const { captureCharFrame, renderer, mockInput } = setup;
    await perform(setup, () => mockInput.typeText('quentin'));
    expect(renderer.isDestroyed).toBe(false);
    expect(captureCharFrame()).toContain('quentin');
    await perform(setup, () => mockInput.pressCtrlC()).catch(() => undefined);
    expect(renderer.isDestroyed).toBe(true);
  });
});

describe('App sign out', () => {
  it('goes back to the login screen with the organisation filled in', async () => {
    const setup = await render(signedIn);
    // Sign out is the last item: one step left of the first wraps to it.
    await perform(setup, () => setup.mockInput.pressArrow('left'));
    await perform(setup, () => setup.mockInput.pressEnter());
    const frame = await setup.waitForFrame((f) => f.includes('Sign in') && f.includes('Login'));
    expect(frame).toContain('org-1');
    expect(frame).not.toContain('New mission');
    setup.renderer.destroy();
  });
});

describe('App while a comment is being typed', () => {
  it('does not quit on q, which is part of the comment', async () => {
    const waiting = mission({
      ...summary(1),
      status: 'pending_approval',
      allowedActions: ['approve', 'reject'],
      crewValidation: undefined,
    });
    const setup = await testRender(
      <App
        session={{ ...signedIn, role: 'director' }}
        apis={fakeApis({
          missions: fakeApi([pageOf([summary(1)])], waiting),
          users: fakeUsersApi(),
          skills: fakeSkillsApi(),
          settings: fakeSettingsApi(),
        })}
        onLogin={never}
        onAcceptInvite={() => Promise.reject(new Error('unused'))}
        onSignOut={afterSignOut}
      />,
      { width: 100, height: 30 },
    );
    await settle(setup);
    await perform(setup, () => setup.mockInput.pressEnter());
    await settle(setup);
    await perform(setup, () => setup.mockInput.pressKey('a'));
    await perform(setup, () => setup.mockInput.typeText('quit now'));
    expect(setup.renderer.isDestroyed).toBe(false);
    expect(setup.captureCharFrame()).toContain('quit now');
    setup.renderer.destroy();
  });
});

describe('App Users section', () => {
  it('does not quit on q while the invite form is being typed in', async () => {
    const setup = await testRender(
      <App
        session={{ ...signedIn, role: 'director' }}
        apis={fakeApis({
          missions: fakeApi([pageOf([])]),
          users: fakeUsersApi([{ items: [], nextCursor: null }]),
          skills: fakeSkillsApi(),
          settings: fakeSettingsApi(),
        })}
        onLogin={never}
        onAcceptInvite={() => Promise.reject(new Error('unused'))}
        onSignOut={afterSignOut}
      />,
      { width: 100, height: 30 },
    );
    await settle(setup);
    await perform(setup, () => setup.mockInput.pressArrow('right')); // Missions
    await perform(setup, () => setup.mockInput.pressArrow('right')); // Users
    await settle(setup);
    await perform(setup, () => setup.mockInput.pressKey('i'));
    await perform(setup, () => setup.mockInput.typeText('quit@example.com'));
    expect(setup.renderer.isDestroyed).toBe(false);
    expect(setup.captureCharFrame()).toContain('quit@example.com');
    setup.renderer.destroy();
  });
});

describe('App Settings section', () => {
  it('does not quit on q, or change section, while the settings form is being edited', async () => {
    const setup = await testRender(
      <App
        session={{ ...signedIn, role: 'director' }}
        apis={fakeApis({
          missions: fakeApi([pageOf([])]),
          users: fakeUsersApi(),
          skills: fakeSkillsApi(),
          settings: fakeSettingsApi(),
        })}
        onLogin={never}
        onAcceptInvite={() => Promise.reject(new Error('unused'))}
        onSignOut={afterSignOut}
      />,
      { width: 100, height: 30 },
    );
    await settle(setup);
    for (let i = 0; i < 4; i++) await perform(setup, () => setup.mockInput.pressArrow('right'));
    await settle(setup);
    await perform(setup, () => setup.mockInput.pressEnter()); // engage the form
    await perform(setup, () => setup.mockInput.pressKey('u', { ctrl: true }));
    await perform(setup, () => setup.mockInput.typeText('Asia/Qatar'));
    await perform(setup, () => setup.mockInput.pressArrow('left'));
    expect(setup.renderer.isDestroyed).toBe(false);
    const frame = setup.captureCharFrame();
    expect(frame).toContain('Organisation settings');
    expect(frame).toContain('Asia/Qatar');
    setup.renderer.destroy();
  });
});
