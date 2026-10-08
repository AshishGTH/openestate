import type { JwtPayload } from '@openestate/shared';

export type Surface = 'staff' | 'portal';

// The portal path prefix, kept in sync with csrf-cookie-names.ts.
import { PORTAL_PATH_PREFIX } from './csrf-cookie-names';

/**
 * The surface a request's ROUTE belongs to, decided by URL path alone.
 * Default is 'staff': anything not explicitly under the portal prefix is
 * a staff route, so a newly added route is staff-only without anyone
 * remembering to mark it.
 */
export function routeSurface(path: string): Surface {
  return path.startsWith(PORTAL_PATH_PREFIX) ? 'portal' : 'staff';
}

/**
 * The surface a TOKEN belongs to: its signed `surface` claim, or null when the
 * claim is missing or not one of the two known values. There is deliberately no
 * fallback that infers it from applicantId/brokerId: that existed only so
 * sessions issued before v0.8.1 (which carried no claim) stayed valid, and an
 * access token lives 15 minutes, so none can still be live. A claim-less token
 * is refused (SessionSurfaceGuard answers 401, the client refreshes and gets a
 * token with the claim).
 */
export function tokenSurface(user: JwtPayload): Surface | null {
  return user.surface === 'staff' || user.surface === 'portal' ? user.surface : null;
}

/**
 * A token is internally consistent iff its claimed surface matches its id
 * fields: a portal token carries exactly one of applicantId/brokerId; a staff
 * token carries neither. Rejecting inconsistent tokens stops a crafted or
 * mis-issued token from claiming staff surface while carrying portal ids or
 * vice versa. A token with no valid claim is never consistent.
 */
export function tokenIsConsistent(user: JwtPayload): boolean {
  const surface = tokenSurface(user);
  if (!surface) return false;
  const hasPortalId = !!(user.applicantId || user.brokerId);
  const hasBothIds = !!(user.applicantId && user.brokerId);
  if (hasBothIds) return false;
  return surface === 'portal' ? hasPortalId : !hasPortalId;
}
