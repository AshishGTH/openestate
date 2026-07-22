import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './guards/jwt-auth.guard';
import {
  CSRF_HEADER,
  PORTAL_CSRF_COOKIE,
  PORTAL_PATH_PREFIX,
  STAFF_CSRF_COOKIE,
} from './csrf-cookie-names';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Shared double-submit CSRF mechanism for both staff and portal cookie
 * sessions (Phase 6 decisions: "shared mechanism, parametrized"). Which
 * cookie a request must present is chosen by path prefix, not by a
 * per-route decorator — every portal route lives under PORTAL_PATH_PREFIX,
 * so this needs no per-controller wiring.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    if (SAFE_METHODS.has(request.method)) return true;

    const cookieName: string = request.path?.startsWith(PORTAL_PATH_PREFIX)
      ? PORTAL_CSRF_COOKIE
      : STAFF_CSRF_COOKIE;
    const cookieToken = request.cookies?.[cookieName];
    const headerToken = request.headers[CSRF_HEADER];

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      throw new ForbiddenException('CSRF token mismatch');
    }

    return true;
  }
}
