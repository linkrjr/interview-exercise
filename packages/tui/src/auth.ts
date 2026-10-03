import { AcceptInviteRequestSchema, SessionSchema, type Session } from '@mc/contracts';
import { CliError, type ApiClient, type Store } from '@mc/cli';

export interface LoginInput {
  email: string;
  orgId: string;
  password: string;
}

/** A failure to show the person as it is: the server's problem text, a missing field, or no connection. */
export class LoginError extends Error {}

/**
 * Signs in the way `mc auth login` does: POST /v1/auth/login with the organisation, email and
 * password, then store the session in the CLI's credentials file, so the two clients share a
 * sign-in. The password goes to the server and nowhere else.
 */
export async function login(client: ApiClient, store: Store, input: LoginInput): Promise<Session> {
  const email = input.email.trim();
  const orgId = input.orgId.trim();
  const missing = [
    !email && 'Email',
    !orgId && 'Organisation',
    !input.password && 'Password',
  ].filter(Boolean);
  if (missing.length > 0) throw new LoginError(`${missing.join(', ')} required`);

  let session: Session;
  try {
    session = SessionSchema.parse(
      await client.request('POST', '/v1/auth/login', {
        auth: 'none',
        body: { orgId, email, password: input.password },
      }),
    );
  } catch (error) {
    // CliError carries the server's problem text (field errors included) or the connection failure.
    if (error instanceof CliError) throw new LoginError(error.message);
    throw new LoginError('The server sent an unexpected answer');
  }
  await storeSession(store, session);
  return session;
}

async function storeSession(store: Store, session: Session): Promise<void> {
  await store.setCredentials({
    orgId: session.orgId,
    userId: session.userId,
    role: session.role,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
  });
}

export interface AcceptInviteInput {
  code: string;
  name: string;
  password: string;
  /** The password typed a second time, as `mc auth accept-invite` asks for it. */
  confirm: string;
}

/**
 * Accepts an invite the way `mc auth accept-invite` does: POST /v1/auth/accept-invite with the code,
 * the person's name and a new password, then store the session it returns (the person is signed in).
 * What can be checked without the server (missing fields, a password that does not match or is too
 * short) is checked first.
 */
export async function acceptInvite(
  client: ApiClient,
  store: Store,
  input: AcceptInviteInput,
): Promise<Session> {
  const code = input.code.trim();
  const name = input.name.trim();
  const missing = [
    !code && 'Invite code',
    !name && 'Name',
    !input.password && 'Password',
    !input.confirm && 'Confirm password',
  ].filter(Boolean);
  if (missing.length > 0) throw new LoginError(`${missing.join(', ')} required`);
  if (input.password !== input.confirm) throw new LoginError('The passwords do not match');
  const checked = AcceptInviteRequestSchema.safeParse({ code, name, password: input.password });
  if (!checked.success) throw new LoginError(checked.error.issues[0]?.message ?? 'Invalid input');

  let session: Session;
  try {
    session = SessionSchema.parse(
      await client.request('POST', '/v1/auth/accept-invite', {
        auth: 'none',
        body: checked.data,
      }),
    );
  } catch (error) {
    if (error instanceof CliError) throw new LoginError(error.message);
    throw new LoginError('The server sent an unexpected answer');
  }
  await storeSession(store, session);
  return session;
}

/**
 * Signs out the way `mc auth logout` does: revoke the refresh token on the server (best effort, the
 * local tokens go even if the server cannot be reached), then forget the tokens but keep the
 * organisation, so the login screen starts with it filled in.
 */
export async function logout(client: ApiClient, store: Store): Promise<void> {
  const credentials = await store.getCredentials();
  if (credentials.refreshToken) {
    await client
      .request('POST', '/v1/auth/logout', {
        auth: 'none',
        body: { refreshToken: credentials.refreshToken },
      })
      .catch(() => undefined);
  }
  await store.clearCredentials({ orgId: credentials.orgId });
}
