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
    .find((c) => c.startsWith('openestate_portal_csrf='));
  return match ? match.split('=')[1] : null;
}

async function refreshAccessToken(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/portal/auth/refresh`, {
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
 * De-duped refresh — see apps/web/src/lib/api.ts's identical function for
 * the full explanation (same bug, same root cause, same fix, in both
 * clients, per this project's mirrored-auth standing rule). Every caller
 * wanting a fresh session shares ONE in-flight /portal/auth/refresh
 * request instead of racing its own.
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
      // /portal/auth/refresh rotates the CSRF cookie (a new random value on
      // every call — see portal-auth.controller.ts), so the `csrf` value
      // read above, before this refresh happened, is now stale. See
      // apps/web/src/lib/api.ts's identical fix for the full explanation —
      // same bug, same root cause, same fix, in both clients.
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

/** Same "fetch as blob, download via object URL" pattern as apps/web — the
 * Bearer token lives in memory only, so a plain <a href> can't carry it. */
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
    // deliberately swallow this error to avoid blocking their own flow,
    // which would otherwise leave the user with zero feedback.
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

/**
 * Fetches an authenticated binary response as a blob object URL, for
 * rendering inline (an <img src>) rather than triggering a save-as
 * download — v0.2.2's project/construction-progress photo galleries.
 * Caller owns the returned URL and must URL.revokeObjectURL() it when
 * done (see Property.tsx's AuthedImage, which does this on unmount).
 */
export async function fetchAsObjectUrl(path: string): Promise<string> {
  const url = `${API_BASE}/api/v1${path}`;
  const headers = new Headers();
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  const res = await fetch(url, { headers, credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to load image: ${res.status}`);
  return URL.createObjectURL(await res.blob());
}
