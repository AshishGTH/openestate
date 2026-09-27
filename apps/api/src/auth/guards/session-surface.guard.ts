import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { JwtPayload } from '@openestate/shared';
import { IS_PUBLIC_KEY } from './jwt-auth.guard';
import { routeSurface, tokenSurface, tokenIsConsistent } from '../surface';

/**
 * Enforces the staff/portal boundary structurally, independent of any
 * permission. A staff route rejects a portal token; a portal route rejects
 * a staff token; an internally inconsistent token is rejected outright.
 *
 * Runs after JwtAuthGuard (so request.user is set) and after the
 * 2FA-pending guard, but BEFORE CsrfGuard and PermissionsGuard: a
 * wrong-surface request must die before any permission is consulted.
 *
 * Default-deny by construction: routeSurface() treats anything outside the
 * portal prefix as staff, so a new route is staff-only until deliberately
 * placed under the portal prefix. No per-route opt-in exists to weaken this.
 */
@Injectable()
export class SessionSurfaceGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const user = req.user;
    // No authenticated user: not this guard's concern; JwtAuthGuard handles it.
    if (!user) return true;

    if (!tokenIsConsistent(user)) {
      throw new ForbiddenException('Token surface is inconsistent with its account type.');
    }

    // req.path excludes the query string. It includes the global prefix
    // (/api/v1/...), which is what PORTAL_PATH_PREFIX is written against.
    const wanted = routeSurface(req.path);
    const held = tokenSurface(user);
    if (wanted !== held) {
      throw new ForbiddenException('This session type may not access this route.');
    }
    return true;
  }
}
