// Shared between CsrfGuard (which validates) and both auth controllers
// (which set/clear the cookie) so the two names can never drift apart.
export const STAFF_CSRF_COOKIE = 'openestate_csrf';
export const PORTAL_CSRF_COOKIE = 'openestate_portal_csrf';
export const CSRF_HEADER = 'x-csrf-token';

// Global prefix (main.ts: app.setGlobalPrefix('api/v1')) + the portal
// module's route prefix. CsrfGuard uses this to pick which cookie a given
// request must present — the double-submit mechanism itself is identical
// for both realms, only the cookie pair differs (Phase 6 decisions).
export const PORTAL_PATH_PREFIX = '/api/v1/portal/';
