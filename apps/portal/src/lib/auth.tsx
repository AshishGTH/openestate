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
    identifier: string,
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
    // Cooldown check — hydrate from cached JWT payload (never the raw token,
    // Phase 1 rule intact) and skip firing another /portal/auth/refresh.
    // Mirrors apps/web's identical fix; see api.ts's auth-cache block for
    // the full reasoning. RENDERING ONLY — the server re-verifies every
    // request; a tampered cache cannot grant access, only briefly mis-render.
    const cached = readAuthCache();
    if (cached) {
      setState({ user: cached.payload, isLoading: false });
      return;
    }

    // refreshSession() shares its in-flight request with api()'s own 401-retry
    // and any concurrent caller, including a second invocation of this same
    // effect under React.StrictMode. Seeds the cooldown cache on success.
    refreshSession().then((accessToken) => {
      setState(accessToken ? { user: decodeJwt(accessToken), isLoading: false } : { user: null, isLoading: false });
    });
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    try {
      const res = await api<
        | { accessToken: string }
        | { requiresTwoFactor: true; tempToken: string }
      >('/portal/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier, password }),
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
  }, []);

  const verifyTotp = useCallback(async (tempToken: string, code: string) => {
    try {
      // The 2FA-pending login response never calls setAccessToken (there's
      // no real session yet) — this call needs the short-lived tempToken
      // as its own Bearer, not whatever (usually nothing) accessToken
      // currently holds.
      setAccessToken(tempToken);
      const res = await api<{ accessToken: string }>('/portal/auth/totp/verify', {
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
      await api('/portal/auth/logout', { method: 'POST' });
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
