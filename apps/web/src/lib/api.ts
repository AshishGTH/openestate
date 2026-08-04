import { toast } from './toast';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

function getCsrfToken(): string | null {
  const match = document.cookie
    .split('; ')
    .find((c) => c.startsWith('openestate_csrf='));
  return match ? match.split('=')[1] : null;
}

async function refreshAccessToken(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    accessToken = data.accessToken;
    return accessToken;
  } catch {
    return null;
  }
}

/**
 * De-duped refresh: every caller wanting a fresh session — AuthProvider's
 * mount-time check, and api()'s own 401-retry below — shares ONE in-flight
 * /auth/refresh request instead of firing its own. Without this,
 * React.StrictMode's dev-mode double-effect-invocation (or, in production,
 * two components independently needing a fresh session at the same
 * moment) fires two concurrent refreshes; the second one 401s once the
 * first has already rotated the refresh cookie, and if it resolves after
 * the first, its failure silently overwrites the just-established session.
 * See CLAUDE.md's apps/e2e entry for the bug this was caught by.
 */
export function refreshSession(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = refreshAccessToken().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${API_BASE}/api/v1${path}`;

  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  const csrf = getCsrfToken();
  if (csrf) {
    headers.set('X-CSRF-Token', csrf);
  }

  let res = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (res.status === 401 && accessToken) {
    const newToken = await refreshSession();
    if (newToken) {
      headers.set('Authorization', `Bearer ${newToken}`);
      // /auth/refresh rotates the CSRF cookie (a new random value on every
      // call — see auth.controller.ts), so the `csrf` value read above,
      // before this refresh happened, is now stale. Re-reading here is not
      // optional: retrying with the old header value sends a real,
      // well-formed token that simply no longer matches the now-rotated
      // cookie, which CsrfGuard correctly rejects as "CSRF token mismatch"
      // — not "missing", a genuine mismatch. This is the bug that made
      // every mutation right after an access-token expiry (~15 min into a
      // session, whenever JWT_ACCESS_EXPIRES_IN elapses) fail with a CSRF
      // error on the VM.
      const refreshedCsrf = getCsrfToken();
      if (refreshedCsrf) {
        headers.set('X-CSRF-Token', refreshedCsrf);
      }
      res = await fetch(url, { ...options, headers, credentials: 'include' });
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message ?? `API error ${res.status}`);
    (err as ApiError).status = res.status;
    (err as ApiError).body = body;
    throw err;
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Downloads a binary response (PDF, CSV) through the same auth as `api()`.
 * A plain `window.open`/`<a href>` navigation can't carry the in-memory
 * Bearer token (by design — CLAUDE.md keeps it out of cookies/localStorage),
 * so protected binary endpoints must be fetched here and opened as a blob
 * URL instead.
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const url = `${API_BASE}/api/v1${path}`;
  const headers = new Headers();
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

  const res = await fetch(url, { headers, credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = body.message ?? `Download failed: ${res.status}`;
    // Not a TanStack Query mutation, so MutationCache's global onError
    // (main.tsx) never sees this — toast here directly. Several call sites
    // deliberately swallow this error to avoid blocking their own flow
    // (e.g. a saved receipt whose PDF failed to generate), which would
    // otherwise leave the user with zero feedback that the download failed.
    toast.error(message);
    throw new Error(message);
  }

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}
