import type { JwtPayload } from '@openestate/shared';
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

// -------------------------- session cooldown cache --------------------------
//
// Breaks the CI-only refresh-rotation cascade documented in CLAUDE.md's E2E
// Decisions entry. Under aggressive back-to-back page.goto()s in Playwright
// (which every login-heavy spec runs), each mount's /auth/refresh gets
// aborted mid-flight by the next navigation; the server has already rotated
// a cookie whose acknowledgement never lands, and the jar keeps re-presenting
// the same old token. REFRESH_REUSE_GRACE_SECONDS forgives that — until the
// cascade outlives the window, at which point the still-un-updated token is
// past grace, replay-detection fires, and the family is revoked (session
// dead, parked on /login).
//
// The cooldown breaks the cascade by NOT firing a fresh /auth/refresh on a
// mount that already saw one within AUTH_COOLDOWN_MS. It does NOT weaken
// refresh in any other case: a tab left open then reloaded much later still
// refreshes (stale cache), and any API call whose access token has actually
// expired still hits api()'s 401-retry below (which now works without a
// prior in-memory accessToken — see the relaxed gate).
//
// The cache holds the DECODED JWT PAYLOAD, not the raw token. Phase 1's
// "access token in memory, not localStorage" decision specifically protects
// the raw bearer credential — an XSS reading it gains a 15-minute reusable
// session. The payload has no such property: the server re-verifies the
// signature on every request, and any successful API response already
// discloses those claims. Storing the payload is not a Phase 1 violation;
// see CLAUDE.md's E2E entry for the full read.
//
// RENDERING ONLY. This cache MUST NEVER be consulted to decide access — only
// to decide what to draw (nav visibility, greeting name, permission-gated
// button rendering). A tampered sessionStorage entry granting UI access the
// server would refuse is a real vulnerability; the server is the sole
// authorization authority, and every gated action is checked there.
//
// The 5s window matches the timescale of the Playwright cascade (page.goto()s
// land <1s apart). Do not widen without re-reading the cascade analysis.

// Distinct key per app: in production both apps live on the same origin
// (nginx serves /admin from apps/web, /portal from apps/portal), so a shared
// sessionStorage key would let a staff session in one tab briefly mis-hydrate
// a portal session's user state in another (and vice versa) before the first
// API call's 401-retry corrected it via the app-specific refresh endpoint.
const AUTH_CACHE_KEY = '_authCacheStaff';
export const AUTH_COOLDOWN_MS = 5000;

export interface AuthCache {
  payload: JwtPayload;
  refreshedAt: number;
}

export function decodeJwt(token: string): JwtPayload | null {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

export function readAuthCache(): AuthCache | null {
  try {
    const raw = sessionStorage.getItem(AUTH_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthCache;
    if (typeof parsed.refreshedAt !== 'number' || !parsed.payload) return null;
    if (Date.now() - parsed.refreshedAt > AUTH_COOLDOWN_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeAuthCache(token: string): void {
  const payload = decodeJwt(token);
  if (!payload) return;
  try {
    sessionStorage.setItem(
      AUTH_CACHE_KEY,
      JSON.stringify({ payload, refreshedAt: Date.now() }),
    );
  } catch {
    // sessionStorage disabled (Safari private mode, quota exceeded) — best
    // effort; a cache miss falls through to a normal refresh call.
  }
}

export function clearAuthCache(): void {
  try {
    sessionStorage.removeItem(AUTH_CACHE_KEY);
  } catch {
    // as above
  }
}

// ----------------------------------------------------------------------------

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
    if (accessToken) writeAuthCache(accessToken);
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
  // FormData (file uploads) must NOT get an explicit Content-Type — the
  // browser sets multipart/form-data with the correct boundary itself;
  // overriding it here would break every field the browser encodes.
  if (!headers.has('Content-Type') && options.body && !(options.body instanceof FormData)) {
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

  // No `&& accessToken` guard: after a cooldown-skipped mount refresh (see
  // the auth-cache block above), accessToken is null on a fresh page load
  // even though the refresh cookie is still valid — the first call would
  // otherwise be un-retriable and the whole page would fail. refreshSession()
  // returns null cleanly when there's no valid session, so a genuine
  // logged-out 401 still short-circuits back to the caller after one wasted
  // refresh probe (cheap; deduped by refreshSession's own single-flight).
  if (res.status === 401) {
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
