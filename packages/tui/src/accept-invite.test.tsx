import { ApiClient, Store } from '@mc/cli';
import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcceptInviteScreen } from './accept-invite-screen.js';
import { App } from './app.js';
import { acceptInvite, type AcceptInviteInput, LoginError } from './auth.js';
import { ClipboardContext } from './clipboard.js';
import { fakeApis, fakeUsersApi } from './fixtures.js';
import { InvitePopup } from './invite-popup.js';
import { LoginScreen } from './login-screen.js';
import type { SessionInfo } from './session.js';
import { perform, settle } from './test-helpers.js';

const SESSION = {
  accessToken: 'access-1',
  expiresIn: 900,
  refreshToken: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000.secret-1',
  orgId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
  userId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001',
  role: 'crew',
};
const INPUT: AcceptInviteInput = {
  code: ' ORG.secret ',
  name: ' Ann Crew ',
  password: 'a very long password',
  confirm: 'a very long password',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

async function setup(respond: () => Response) {
  const dir = await mkdtemp(join(tmpdir(), 'mc-tui-'));
  const store = new Store(dir);
  await store.setUrl('http://api.test');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new ApiClient(store, async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return respond();
  });
  return { dir, store, client, calls };
}

describe('acceptInvite', () => {
  it('posts code, name and password like `mc auth accept-invite` and stores the session', async () => {
    const { store, client, calls, dir } = await setup(() => json(200, SESSION));
    const session = await acceptInvite(client, store, INPUT);
    expect(session.role).toBe('crew');
    expect(calls[0]!.url).toBe('http://api.test/v1/auth/accept-invite');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      code: 'ORG.secret',
      name: 'Ann Crew',
      password: 'a very long password',
    });
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBeNull();
    expect((await store.getCredentials()).userId).toBe(SESSION.userId);
    expect(await readFile(join(dir, 'credentials.json'), 'utf8')).not.toContain('long password');
  });

  it('checks what it can without calling the server', async () => {
    const { store, client, calls } = await setup(() => json(200, SESSION));
    const fails = (input: Partial<AcceptInviteInput>, message: string) =>
      expect(acceptInvite(client, store, { ...INPUT, ...input })).rejects.toThrow(message);
    await fails(
      { code: ' ', name: '', password: '', confirm: '' },
      'Invite code, Name, Password, Confirm password required',
    );
    await fails({ confirm: 'something else entirely' }, 'The passwords do not match');
    await fails({ password: 'short', confirm: 'short' }, 'at least 12 characters');
    expect(calls).toEqual([]);
  });

  it("shows the server's problem and stores nothing for a bad code", async () => {
    const { store, client } = await setup(() =>
      json(400, {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        code: 'INVITE_INVALID',
        detail: 'The invite is invalid or has expired',
      }),
    );
    const failure = await acceptInvite(client, store, INPUT).catch((e) => e);
    expect(failure).toBeInstanceOf(LoginError);
    expect(failure.message).toContain('The invite is invalid or has expired');
    expect(await store.getCredentials()).toEqual({});
  });
});

async function screen(onAccept: (i: AcceptInviteInput) => Promise<void>, onBack = () => {}) {
  const s = await testRender(<AcceptInviteScreen onAccept={onAccept} onBack={onBack} />, {
    width: 80,
    height: 40,
  });
  await s.renderOnce();
  return s;
}
type Setup = Awaited<ReturnType<typeof screen>>;
const type = (s: Setup, t: string) => perform(s, () => s.mockInput.typeText(t));
const tab = (s: Setup) => perform(s, () => s.mockInput.pressTab());
const enter = (s: Setup) => perform(s, () => s.mockInput.pressEnter());

describe('AcceptInviteScreen', () => {
  it('asks for the code, a name and the password twice', async () => {
    const s = await screen(async () => {});
    const frame = s.captureCharFrame();
    for (const t of [
      'Invite code',
      'Your name',
      'New password',
      'Confirm password',
      'Accept invite',
      'Back to sign in',
    ])
      expect(frame).toContain(t);
    s.renderer.destroy();
  });

  it('sends what was typed, and never shows the passwords', async () => {
    const got: AcceptInviteInput[] = [];
    const s = await screen(async (i) => void got.push(i));
    await type(s, 'ORG.secret');
    await tab(s);
    await type(s, 'Ann');
    await tab(s);
    await type(s, 'a very long password');
    await tab(s);
    await type(s, 'a very long password');
    expect(s.captureCharFrame()).not.toContain('long password');
    await enter(s);
    await settle(s);
    expect(got).toEqual([
      {
        code: 'ORG.secret',
        name: 'Ann',
        password: 'a very long password',
        confirm: 'a very long password',
      },
    ]);
    s.renderer.destroy();
  });

  it('shows a refusal, clears the passwords and lets the person try again', async () => {
    let attempts = 0;
    const s = await screen(async () => {
      if (++attempts === 1) throw new Error('The passwords do not match');
    });
    await tab(s);
    await tab(s);
    await tab(s);
    await tab(s); // on the button
    await enter(s);
    await settle(s);
    expect(s.captureCharFrame()).toContain('The passwords do not match');
    await enter(s);
    await settle(s);
    expect(attempts).toBe(2);
    s.renderer.destroy();
  });

  it('Esc goes back', async () => {
    let back = 0;
    const s = await screen(
      async () => {},
      () => void back++,
    );
    await perform(s, () => s.mockInput.pressEscape());
    await new Promise((r) => setTimeout(r, 100));
    expect(back).toBe(1);
    s.renderer.destroy();
  });
});

describe('the sign-in screen', () => {
  it('offers Accept invite below the Login button, reached with Tab and Enter', async () => {
    let opened = 0;
    const s = await testRender(
      <LoginScreen onLogin={async () => {}} onAcceptInvite={() => void opened++} />,
      { width: 80, height: 40 },
    );
    await s.renderOnce();
    const lines = s.captureCharFrame().split('\n');
    const login = lines.findIndex((l) => l.includes('Login'));
    expect(lines.findIndex((l) => l.includes('Accept invite'))).toBeGreaterThan(login);
    for (let i = 0; i < 4; i++) await perform(s, () => s.mockInput.pressTab());
    await perform(s, () => s.mockInput.pressEnter());
    expect(opened).toBe(1);
    s.renderer.destroy();
  });

  it('switches to the invite screen and back, and signs in after accepting', async () => {
    const signedOut: SessionInfo = {
      apiUrl: 'http://x',
      orgId: undefined,
      role: undefined,
      signedIn: false,
    };
    const accepted: AcceptInviteInput[] = [];
    const s = await testRender(
      <App
        session={signedOut}
        apis={fakeApis()}
        onLogin={async () => signedOut}
        onAcceptInvite={async (i) => {
          accepted.push(i);
          return { ...signedOut, orgId: 'org-1', role: 'crew', userId: 'u', signedIn: true };
        }}
        onSignOut={async () => signedOut}
      />,
      { width: 100, height: 40 },
    );
    await s.renderOnce();
    for (let i = 0; i < 4; i++) await perform(s, () => s.mockInput.pressTab());
    await perform(s, () => s.mockInput.pressEnter());
    expect(s.captureCharFrame()).toContain('Accept an invite');
    await perform(s, () => s.mockInput.pressEscape());
    await new Promise((r) => setTimeout(r, 100));
    await settle(s);
    expect(s.captureCharFrame()).toContain('Sign in');

    for (let i = 0; i < 4; i++) await perform(s, () => s.mockInput.pressTab());
    await perform(s, () => s.mockInput.pressEnter());
    await perform(s, () => s.mockInput.typeText('ORG.secret'));
    await perform(s, () => s.mockInput.pressTab());
    await perform(s, () => s.mockInput.typeText('Ann'));
    await perform(s, () => s.mockInput.pressTab());
    await perform(s, () => s.mockInput.typeText('a very long password'));
    await perform(s, () => s.mockInput.pressTab());
    await perform(s, () => s.mockInput.typeText('a very long password'));
    await perform(s, () => s.mockInput.pressEnter());
    await settle(s);
    expect(accepted).toHaveLength(1);
    expect(s.captureCharFrame()).toContain('crew · org-1');
    s.renderer.destroy();
  });
});

describe('copying the invite code', () => {
  async function invitePopup(copy: (text: string) => Promise<boolean>) {
    const s = await testRender(
      <ClipboardContext.Provider value={copy}>
        <InvitePopup api={fakeUsersApi()} onClose={() => {}} onInvited={() => {}} />
      </ClipboardContext.Provider>,
      { width: 100, height: 30 },
    );
    await s.renderOnce();
    await perform(s, () => s.mockInput.typeText('new@example.com'));
    await perform(s, () => s.mockInput.pressEnter());
    await settle(s);
    return s;
  }

  it('copies the code with c and says so', async () => {
    const copied: string[] = [];
    const s = await invitePopup(async (t) => (copied.push(t), true));
    expect(s.captureCharFrame()).toContain('Copy (c)');
    await perform(s, () => s.mockInput.pressKey('c'));
    await settle(s);
    expect(copied).toEqual(['ORG.secret-code']);
    expect(s.captureCharFrame()).toContain('Copied to the clipboard.');
    s.renderer.destroy();
  });

  it('copies on a click of the button, and says when it could not', async () => {
    const s = await invitePopup(async () => false);
    const lines = s.captureCharFrame().split('\n');
    const y = lines.findIndex((l) => l.includes('Copy (c)'));
    await perform(s, () => s.mockMouse.click(lines[y]!.indexOf('Copy') + 1, y));
    await settle(s);
    expect(s.captureCharFrame()).toContain('Could not copy');
    s.renderer.destroy();
  });
});
