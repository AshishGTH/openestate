import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { JwtPayload } from '@openestate/shared';
import {
  api,
  setAccessToken,
  refreshSession,
  readAuthCache,
  writeAuthCache,
  clearAuthCache,
  decodeJwt,
} from './api';

interface AuthState {
  user: JwtPayload | null;
  isLoading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (
    email: string,
    password: string,
  ) => Promise<
    | { ok: true }
    | { ok: false; requiresTwoFactor: true; tempToken: string }
    | { ok: false; error: string }
  >;
  verifyTotp: (tempToken: string, code: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  logout: () => Promise<void>;
  hasPermission: (perm: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, isLoading: true });

  useEffect(() => {
    // Cooldown check — if we successfully refreshed within AUTH_COOLDOWN_MS
    // (see api.ts's auth-cache block for the full reasoning), hydrate
    // `state.user` from the cached JWT PAYLOAD (never the raw token) and
    // skip firing another /auth/refresh. This exists solely to break the CI
    // Playwright refresh-rotation cascade under back-to-back page.goto()s;
    // it does NOT weaken normal refresh — a tab left open then reloaded
    // much later still refreshes, and any actually-expired access token
    // still triggers api()'s 401-retry.
    //
    // RENDERING ONLY: state.user's permissions here are used to decide what
    // to DRAW (nav, gated buttons). The server re-verifies every request; a
    // tampered cache cannot grant access, only briefly mis-render.
    //
    // In-memory `accessToken` stays null during a cooldown-skip. The first
    // real API call will 401 (no Authorization header), which api()'s
    // relaxed 401-retry gate handles: it fires refreshSession() without
    // needing a prior in-memory token, gets a fresh one, retries with it.
    const cached = readAuthCache();
    if (cached) {
      setState({ user: cached.payload, isLoading: false });
      return;
    }

    // refreshSession() shares its in-flight request with api()'s own 401-retry
    // refresh and any concurrent caller, including a second invocation of this
    // same effect under React.StrictMode. Without that sharing, two concurrent
    // /auth/refresh calls race the single-use refresh-token rotation: the
    // loser 401s, and if it resolves second, its failure overwrites the
    // session the winner just established. setAccessToken is already handled
    // inside refreshSession()/refreshAccessToken(), and refreshAccessToken
    // seeds the cooldown cache on success.
    refreshSession().then((accessToken) => {
      setState(accessToken ? { user: decodeJwt(accessToken), isLoading: false } : { user: null, isLoading: false });
    });
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      try {
        const res = await api<
          | { accessToken: string }
          | { requiresTwoFactor: true; tempToken: string }
        >('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });

        if ('requiresTwoFactor' in res && res.requiresTwoFactor) {
          return { ok: false as const, requiresTwoFactor: true as const, tempToken: res.tempToken };
        }

        const { accessToken } = res as { accessToken: string };
        setAccessToken(accessToken);
        writeAuthCache(accessToken);
        setState({ user: decodeJwt(accessToken), isLoading: false });
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    },
    [],
  );

  const verifyTotp = useCallback(async (tempToken: string, code: string) => {
    try {
      // The 2FA-pending login response never calls setAccessToken (there's
      // no real session yet) — this call needs the short-lived tempToken
      // as its own Bearer, not whatever (usually nothing) accessToken
      // currently holds. Mirrors apps/portal/src/lib/auth.tsx's same fix.
      setAccessToken(tempToken);
      const res = await api<{ accessToken: string }>('/auth/totp/verify', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      setAccessToken(res.accessToken);
      writeAuthCache(res.accessToken);
      setState({ user: decodeJwt(res.accessToken), isLoading: false });
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    setAccessToken(null);
    clearAuthCache();
    setState({ user: null, isLoading: false });
  }, []);

  const hasPermission = useCallback(
    (perm: string) => state.user?.permissions.includes(perm) ?? false,
    [state.user],
  );

  const value = useMemo(
    () => ({ ...state, login, verifyTotp, logout, hasPermission }),
    [state, login, verifyTotp, logout, hasPermission],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
