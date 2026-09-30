import { ForbiddenException } from '@nestjs/common';
import type { PrismaClient } from '@openestate/db';

/**
 * v0.8.2: "you cannot act on or grant beyond what you hold." Shared by
 * UsersService (acting on another user) and RolesService (editing a
 * role's own permission set) — see CLAUDE.md's v0.8.2 decisions entry
 * for the full investigation this closes.
 */

export interface CallerContext {
  id: string;
  roleId: string;
  roleSlug: string;
  isActive: boolean;
  permissionKeys: string[];
}

/**
 * Loads the CALLER fresh from the database by id — never trusts
 * roleId/permissions from the JWT, which is a snapshot taken at
 * login/refresh time. If the caller's role changed (to a different role,
 * not just narrowed) or their account was deactivated after that snapshot
 * was issued, their still-valid access token would otherwise carry stale,
 * over-broad authority for up to its remaining lifetime.
 */
export async function loadCurrentCaller(
  systemPrisma: PrismaClient,
  callerId: string,
): Promise<CallerContext> {
  const user = await systemPrisma.user.findUniqueOrThrow({
    where: { id: callerId },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  return {
    id: user.id,
    roleId: user.roleId,
    roleSlug: user.role.slug,
    isActive: user.isActive,
    permissionKeys: user.role.permissions.map((rp) => rp.permission.key),
  };
}

/** Refuses if the freshly-loaded caller's own account is no longer active. */
export function assertCallerActive(caller: CallerContext): void {
  if (!caller.isActive) {
    throw new ForbiddenException('Your account is no longer active.');
  }
}

/**
 * The caller's own permission set must be a superset of `targetPermissionKeys`.
 * A set is always a subset of itself, so two callers with IDENTICAL
 * permission sets (e.g. two company_admin peers) pass this check — that's
 * deliberate (v0.8.2 Part F item 6), not an oversight: peer administrators
 * acting on one another is ordinary admin behaviour, and accountability for
 * it rests on the audit log, not a restriction here.
 *
 * `targetPermissionKeys` must already be the fully-expanded, database-stored
 * list (what `role_permissions` actually holds), never a wildcard-prefix
 * string like "admin.*" from the ROLE_PERMISSIONS constant — comparing
 * against the constant instead of the database rows would silently
 * reintroduce a wildcard-vs-literal mismatch.
 */
export function assertPermissionSubset(
  callerPermissionKeys: string[],
  targetPermissionKeys: string[],
  message = 'You do not have all the permissions this action requires.',
): void {
  const callerSet = new Set(callerPermissionKeys);
  const missing = targetPermissionKeys.filter((k) => !callerSet.has(k)).sort();
  if (missing.length > 0) {
    throw new ForbiddenException(`${message} Missing: ${missing.join(', ')}`);
  }
}

/**
 * The super_admin role is actionable only by another super_admin — stated
 * explicitly rather than left to fall out of the subset check implicitly.
 * The subset check alone would already block anyone but a super_admin from
 * acting on a super_admin target (since super_admin holds every permission
 * that exists), but that's an incidental consequence of super_admin's
 * current definition, not a guarantee — a future role that happens to hold
 * every permission without being SLUG-named super_admin would pass the
 * subset check while still not being the role meant to have this authority.
 */
export function assertActorIsSuperAdminIfTargetIs(
  callerRoleSlug: string,
  targetRoleSlug: string,
): void {
  if (targetRoleSlug === 'super_admin' && callerRoleSlug !== 'super_admin') {
    throw new ForbiddenException('Only a super_admin may act on a super_admin account.');
  }
}

/**
 * Refuses if excluding `excludeUserId` would leave the company with zero
 * active super_admin users. Must run inside the same transaction as the
 * write it protects, with the candidate rows locked first (SELECT ... FOR
 * UPDATE — same pattern UsersService.assertValidManager's cycle check
 * already uses elsewhere in this codebase), so two concurrent actions
 * against two different super_admins can't both pass the check and jointly
 * empty the company out. A company with no super_admin role at all has
 * nothing to protect, so this is a silent no-op in that case.
 */
export async function assertSuperAdminNotEmptied(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  companyId: string,
  excludeUserId: string,
): Promise<void> {
  const role = await tx.role.findFirst({ where: { companyId, slug: 'super_admin' } });
  if (!role) return;

  const rows: Array<{ id: string }> = await tx.$queryRaw`
    SELECT id FROM users
    WHERE company_id = ${companyId}::uuid
      AND role_id = ${role.id}::uuid
      AND is_active = true
      AND id != ${excludeUserId}::uuid
    FOR UPDATE
  `;
  if (rows.length === 0) {
    throw new ForbiddenException(
      'This would leave the company with no active super_admin user.',
    );
  }
}
