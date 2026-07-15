import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  signIn as amplifySignIn,
  signOut as amplifySignOut,
  signUp as amplifySignUp,
  confirmSignUp as amplifyConfirmSignUp,
  fetchAuthSession,
} from 'aws-amplify/auth';

export interface AuthUser {
  sub: string;
  email: string;
  name: string;
  groups: string[];
  isAdmin: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<AuthUser>;
  signOut: () => Promise<void>;
  signUp: (email: string, password: string, name: string) => Promise<void>;
  confirm: (email: string, code: string) => Promise<void>;
  refresh: () => Promise<AuthUser | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function sessionUser(forceRefresh = false): Promise<AuthUser | null> {
  try {
    const session = await fetchAuthSession({ forceRefresh });
    const payload = session.tokens?.idToken?.payload;
    if (!payload?.sub) return null;

    const rawGroups = payload['cognito:groups'];
    const groups = Array.isArray(rawGroups) ? rawGroups.map(String) : [];
    const email = String(payload.email ?? '');

    return {
      sub: String(payload.sub),
      email,
      name: String(payload.name ?? '') || email,
      groups,
      isAdmin: groups.includes('admin'),
    };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void sessionUser().then((u) => {
      setUser(u);
      setReady(true);
    });
  }, []);

  const refresh = useCallback(async () => {
    const u = await sessionUser(true);
    setUser(u);
    return u;
  }, []);

  const signIn = useCallback(async (email: string, password: string): Promise<AuthUser> => {
    // A half-signed-in state (e.g. a stale session) makes signIn throw.
    await amplifySignOut().catch(() => undefined);
    const result = await amplifySignIn({ username: email, password });
    if (!result.isSignedIn) {
      throw new Error(`Additional sign-in step required (${result.nextStep.signInStep}) — not part of this demo.`);
    }
    const u = await sessionUser();
    if (!u) throw new Error('Signed in, but no session was established.');
    setUser(u);
    return u;
  }, []);

  const signOut = useCallback(async () => {
    await amplifySignOut();
    setUser(null);
  }, []);

  const signUp = useCallback(async (email: string, password: string, name: string) => {
    await amplifySignUp({
      username: email,
      password,
      options: { userAttributes: { email, name } },
    });
  }, []);

  const confirm = useCallback(async (email: string, code: string) => {
    await amplifyConfirmSignUp({ username: email, confirmationCode: code });
  }, []);

  const value = useMemo(
    () => ({ user, ready, signIn, signOut, signUp, confirm, refresh }),
    [user, ready, signIn, signOut, signUp, confirm, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
