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
import { api, setAccessToken } from './api';

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
  verifyTotp: (code: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  logout: () => Promise<void>;
  hasPermission: (perm: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function decodeJwt(token: string): JwtPayload | null {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, isLoading: true });

  useEffect(() => {
    api<{ accessToken: string }>('/auth/refresh', { method: 'POST' })
      .then(({ accessToken }) => {
        setAccessToken(accessToken);
        setState({ user: decodeJwt(accessToken), isLoading: false });
      })
      .catch(() => {
        setState({ user: null, isLoading: false });
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
        setState({ user: decodeJwt(accessToken), isLoading: false });
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    },
    [],
  );

  const verifyTotp = useCallback(async (code: string) => {
    try {
      const res = await api<{ accessToken: string }>('/auth/totp/verify', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      setAccessToken(res.accessToken);
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
