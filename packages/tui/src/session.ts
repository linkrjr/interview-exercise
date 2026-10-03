import { Store } from '@mc/cli';

export interface SessionInfo {
  /** The API the CLI is pointed at (`mc config set-url`), if any. */
  apiUrl: string | undefined;
  /** The organisation and role of the stored sign-in, if any. */
  orgId: string | undefined;
  /** The signed-in user, for screens about themself (a Crew Member's profile). */
  userId?: string | undefined;
  role: string | undefined;
  signedIn: boolean;
}

/**
 * What the TUI shows on its first screen: it shares the CLI's configuration and credentials
 * (`MC_CONFIG_DIR` or `~/.config/mission-control`), so signing in with `mc auth login` signs in here.
 */
export async function loadSession(store: Store = Store.fromEnv(process.env)): Promise<SessionInfo> {
  const [apiUrl, credentials] = await Promise.all([store.getUrl(), store.getCredentials()]);
  return {
    apiUrl,
    orgId: credentials.orgId,
    userId: credentials.userId,
    role: credentials.role,
    signedIn: Boolean(credentials.accessToken),
  };
}
