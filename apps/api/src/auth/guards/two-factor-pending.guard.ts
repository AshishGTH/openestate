import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtPayload } from '@openestate/shared';
import { PERMISSIONS_KEY } from './permissions.guard';

/**
 * The only permission a 2FA-pending token (what login returns instead of a
 * session when TOTP is on) carries. Deliberately absent from PERMISSIONS, so
 * no role can hold it and no full session token ever carries it — which is
 * what makes it a reliable marker.
 */
export const TWO_FACTOR_PENDING_PERMISSION = 'auth.totp.verify';

/**
 * Long enough to open an authenticator app or dig out a recovery code, far
 * short of a session. Was JWT_ACCESS_EXPIRES_IN (15m) by accident of sharing
 * signAccessToken.
 */
export const TWO_FACTOR_PENDING_TTL_SECONDS = 300;

/**
 * A denylist on the token, not an allowlist on routes. PermissionsGuard lets
 * any route without @RequirePermissions through without looking at the token,
 * so a 2FA-pending token was accepted by every such route — including
 * totp/setup, confirm and disable, which let a password alone strip or take
 * over 2FA. This rejects a 2FA-pending token everywhere except routes that
 * explicitly require TWO_FACTOR_PENDING_PERMISSION (the two totp/verify
 * endpoints), so routes added later are closed without anyone remembering to
 * decorate them. The same decorator that opens a route to a 2FA-pending token
 * closes it to full sessions.
 *
 * Global and registered straight after JwtAuthGuard (app.module.ts), so no
 * controller can opt out. Contains the default-allow policy's blast radius;
 * it does not remove the policy — see docs/todo.md.
 */
@Injectable()
export class TwoFactorPendingGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // @Public routes never populate req.user, so they're untouched.
    const user = context.switchToHttp().getRequest().user as JwtPayload | undefined;
    if (!user?.permissions?.includes(TWO_FACTOR_PENDING_PERMISSION)) return true;

    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required?.includes(TWO_FACTOR_PENDING_PERMISSION)) return true;

    // Plain 403 — says nothing about why.
    throw new ForbiddenException();
  }
}
