import { getCurrentIpAddress } from '@openestate/db';

/**
 * Audit rows for auth events on staff and portal. AuthService,
 * PortalAuthService and UsersService write through SYSTEM_PRISMA, which
 * carries no audit extension, so these rows are written explicitly — the
 * same direct insert as RESET_LINK_ISSUED / PORTAL_RESET_ISSUED.
 *
 * One action name per event, not one per surface: both surfaces write the
 * same fields on the same `users` table, so `after.surface` says which.
 * (The reset-link actions differ per surface because they write different
 * tables.) Names fit audit_logs.action, VarChar(20).
 *
 * `after` must never carry a secret: no password or hash, no TOTP secret,
 * no recovery code, no reset token or its hash.
 */
export type AuthAuditAction =
  | 'TOTP_ENABLED'
  | 'TOTP_DISABLED'
  | 'TOTP_RESET_BY_ADMIN'
  | 'PASSWORD_CHANGED'
  | 'PASSWORD_RESET_USED';

export type AuthSurface = 'staff' | 'portal';

/**
 * The `data` for `auditLog.create`, so it drops into both array and
 * interactive transactions. `ipAddress` is read from the request's tenant
 * context unless passed: @Public() routes (the two password-reset confirms)
 * have no req.user, so TenantContextInterceptor sets no context and their
 * controllers must pass req.ip themselves.
 */
export function authAuditData(row: {
  companyId: string;
  actorId: string;
  targetUserId: string;
  action: AuthAuditAction;
  // Flat scalars only, which keeps it assignable to Prisma's JSON input type.
  after: { surface: AuthSurface } & Record<string, string | boolean | null>;
  ipAddress?: string;
}) {
  return {
    companyId: row.companyId,
    userId: row.actorId,
    entityType: 'User',
    entityId: row.targetUserId,
    action: row.action,
    after: row.after,
    ipAddress: row.ipAddress ?? getCurrentIpAddress() ?? null,
  };
}
