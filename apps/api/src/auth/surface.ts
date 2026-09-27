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
 * The surface a TOKEN belongs to. Prefer the explicit claim; for older
 * tokens that predate it, infer from the portal-only id fields (exactly
 * one of applicantId/brokerId is set on a portal token, neither on a
 * staff token). This keeps pre-fix sessions valid and correctly classified.
 */
export function tokenSurface(user: JwtPayload): Surface {
  if (user.surface === 'staff' || user.surface === 'portal') return user.surface;
  return user.applicantId || user.brokerId ? 'portal' : 'staff';
}

/**
 * A token is internally consistent iff its surface matches its id fields:
 * a portal token carries exactly one of applicantId/brokerId; a staff
 * token carries neither. Rejecting inconsistent tokens stops a crafted or
 * mis-issued token from claiming staff surface while carrying portal ids
 * or vice versa.
 */
export function tokenIsConsistent(user: JwtPayload): boolean {
  const hasPortalId = !!(user.applicantId || user.brokerId);
  const hasBothIds = !!(user.applicantId && user.brokerId);
  if (hasBothIds) return false;
  return tokenSurface(user) === 'portal' ? hasPortalId : !hasPortalId;
}
