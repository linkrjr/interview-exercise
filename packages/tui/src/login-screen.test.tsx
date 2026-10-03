import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import type { LoginInput } from './auth.js';
import { LoginScreen } from './login-screen.js';
import { perform } from './test-helpers.js';

async function render(
  onLogin: (input: LoginInput) => Promise<void>,
  initialOrgId?: string,
  onAcceptInvite: () => void = () => {},
) {
  const setup = await testRender(
    <LoginScreen onLogin={onLogin} initialOrgId={initialOrgId} onAcceptInvite={onAcceptInvite} />,
    {
      width: 80,
      height: 36,
    },
  );
  await setup.renderOnce();
  return setup;
}

type Setup = Awaited<ReturnType<typeof render>>;

const tab = (s: Setup, modifiers?: { shift?: boolean }) =>
  perform(s, () => s.mockInput.pressTab(modifiers));
const enter = (s: Setup) => perform(s, () => s.mockInput.pressEnter());
const type = (s: Setup, text: string) => perform(s, () => s.mockInput.typeText(text));
const click = (s: Setup, x: number, y: number) => perform(s, () => s.mockMouse.click(x, y));

const fill = async (s: Setup, email: string, org: string, password: string) => {
  await type(s, email);
  await tab(s);
  await type(s, org);
  await tab(s);
  await type(s, password);
};

/** Where a word is on the screen, to click on it. */
function find(frame: string, word: string): { x: number; y: number } {
  const lines = frame.split('\n');
  const y = lines.findIndex((l) => l.includes(word));
  if (y < 0) throw new Error(`"${word}" is not on the screen:\n${frame}`);
  return { x: lines[y]!.indexOf(word), y };
}

const recorder = () => {
  const calls: LoginInput[] = [];
  return { calls, onLogin: async (input: LoginInput) => void calls.push(input) };
};

describe('LoginScreen', () => {
  it('has an email, an organisation and a password field and a login button', async () => {
    const s = await render(recorder().onLogin);
    const frame = s.captureCharFrame();
    for (const text of ['Email', 'Organisation', 'Password', 'Login', 'Tab next field']) {
      expect(frame).toContain(text);
    }
    expect(frame.indexOf('Email')).toBeLessThan(frame.indexOf('Organisation'));
    expect(frame.indexOf('Organisation')).toBeLessThan(frame.indexOf('Password'));
    s.renderer.destroy();
  });

  it('starts with the remembered organisation filled in', async () => {
    const s = await render(recorder().onLogin, 'org-remembered');
    expect(s.captureCharFrame()).toContain('org-remembered');
    s.renderer.destroy();
  });

  it('signs in when Enter is hit in the password field', async () => {
    const { calls, onLogin } = recorder();
    const s = await render(onLogin);
    await fill(s, 'lee@example.com', 'org-1', 'a secret');
    await enter(s);
    expect(calls).toEqual([{ email: 'lee@example.com', orgId: 'org-1', password: 'a secret' }]);
    s.renderer.destroy();
  });

  it('signs in when Enter is hit in the email or organisation field too', async () => {
    const { calls, onLogin } = recorder();
    const s = await render(onLogin, 'org-1');
    await type(s, 'lee@example.com');
    await enter(s);
    expect(calls).toEqual([{ email: 'lee@example.com', orgId: 'org-1', password: '' }]);
    s.renderer.destroy();
  });

  it('signs in when the login button is clicked', async () => {
    const { calls, onLogin } = recorder();
    const s = await render(onLogin);
    await fill(s, 'lee@example.com', 'org-1', 'a secret');
    await s.renderOnce();
    const { x, y } = find(s.captureCharFrame(), 'Login');
    await click(s, x + 1, y);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.password).toBe('a secret');
    s.renderer.destroy();
  });

  it('signs in when Enter is hit on the focused button', async () => {
    const { calls, onLogin } = recorder();
    const s = await render(onLogin);
    await fill(s, 'lee@example.com', 'org-1', 'pw');
    await tab(s); // to the button
    await enter(s);
    expect(calls).toHaveLength(1);
    s.renderer.destroy();
  });

  it('moves between fields with Tab and Shift+Tab, wrapping around', async () => {
    const { calls, onLogin } = recorder();
    const s = await render(onLogin);
    await type(s, 'a');
    await tab(s, { shift: true }); // wraps to the button
    await tab(s); // and back to the email
    await type(s, 'b');
    await enter(s);
    expect(calls[0]!.email).toBe('ab');
    s.renderer.destroy();
  });

  it('focuses a field when it is clicked', async () => {
    const { calls, onLogin } = recorder();
    const s = await render(onLogin);
    const { x, y } = find(s.captureCharFrame(), 'organisation id');
    await click(s, x, y);
    await type(s, 'org-9');
    await enter(s);
    expect(calls[0]!.orgId).toBe('org-9');
    s.renderer.destroy();
  });

  it('never shows the password: only a dot per character', async () => {
    const s = await render(recorder().onLogin);
    await tab(s);
    await tab(s);
    await type(s, 'hunter2!');
    await s.renderOnce();
    const frame = s.captureCharFrame();
    expect(frame).not.toContain('hunter2');
    expect(frame).toContain('••••••••');
    s.renderer.destroy();
  });

  it('edits the password with Backspace', async () => {
    const { calls, onLogin } = recorder();
    const s = await render(onLogin);
    await tab(s);
    await tab(s);
    await type(s, 'abcd');
    await perform(s, () => s.mockInput.pressBackspace());
    await type(s, 'X');
    await enter(s);
    expect(calls.at(-1)!.password).toBe('abcX');
    s.renderer.destroy();
  });

  it('clears the password with Ctrl+U, and takes a paste without its line break', async () => {
    const { calls, onLogin } = recorder();
    const s = await render(onLogin);
    await tab(s);
    await tab(s);
    await type(s, 'old');
    await perform(s, () => s.mockInput.pressKey('u', { ctrl: true }));
    await perform(s, () => s.mockInput.pasteBracketedText('pasted-secret\n'));
    await enter(s);
    expect(calls.at(-1)!.password).toBe('pasted-secret');
    s.renderer.destroy();
  });

  it('shows why a sign-in failed, clears the password and keeps the rest', async () => {
    const s = await render(async () => {
      throw new Error('Invalid credentials (INVALID_CREDENTIALS)');
    });
    await fill(s, 'lee@example.com', 'org-1', 'wrong');
    await enter(s);
    const frame = await s.waitForFrame((f) =>
      f.includes('Invalid credentials (INVALID_CREDENTIALS)'),
    );
    expect(frame).toContain('lee@example.com');
    expect(frame).toContain('org-1');
    expect(frame).not.toContain('•');
    expect(frame).not.toContain('wrong');
    s.renderer.destroy();
  });

  it('lets the person try again, with focus back on the password', async () => {
    const calls: LoginInput[] = [];
    const s = await render(async (input) => {
      calls.push(input);
      if (calls.length === 1) throw new Error('nope');
    });
    await fill(s, 'lee@example.com', 'org-1', 'wrong');
    await enter(s);
    await s.waitForFrame((f) => f.includes('nope'));
    await type(s, 'right');
    await enter(s);
    expect(calls.map((c) => c.password)).toEqual(['wrong', 'right']);
    s.renderer.destroy();
  });

  it('ignores a second submit while signing in, and says so', async () => {
    let release!: () => void;
    const calls: LoginInput[] = [];
    const s = await render(
      (input) =>
        new Promise<void>((resolve) => {
          calls.push(input);
          release = resolve;
        }),
    );
    await fill(s, 'lee@example.com', 'org-1', 'pw');
    await enter(s);
    await enter(s);
    expect(calls).toHaveLength(1);
    expect(s.captureCharFrame()).toContain('Signing in');
    release();
    s.renderer.destroy();
  });
});
