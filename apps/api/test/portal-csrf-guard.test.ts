/**
 * Phase 6: CsrfGuard generalized to pick the staff vs. portal cookie pair
 * by URL path prefix (see CLAUDE.md Phase 6 decisions). Unit test, no
 * Postgres needed — same style as permissions-guard.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CsrfGuard } from '../src/auth/csrf.guard';
import { STAFF_CSRF_COOKIE, PORTAL_CSRF_COOKIE, CSRF_HEADER } from '../src/auth/csrf-cookie-names';

function makeContext(opts: {
  method: string;
  path: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  isPublic?: boolean;
}) {
  const reflector = new Reflector();
  const guard = new CsrfGuard(reflector);
  reflector.getAllAndOverride = () => (opts.isPublic ?? false) as never;

  const mockContext = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: opts.method,
        path: opts.path,
        cookies: opts.cookies ?? {},
        headers: opts.headers ?? {},
      }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  };

  return { guard, context: mockContext as never };
}

describe('CsrfGuard (portal generalization)', () => {
  it('rejects a portal POST with no CSRF cookie/header at all', () => {
    const { guard, context } = makeContext({ method: 'POST', path: '/api/v1/portal/auth/change-password' });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('rejects a portal POST with a mismatched cookie/header pair', () => {
    const { guard, context } = makeContext({
      method: 'POST',
      path: '/api/v1/portal/auth/change-password',
      cookies: { [PORTAL_CSRF_COOKIE]: 'token-a' },
      headers: { [CSRF_HEADER]: 'token-b' },
    });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('rejects a portal POST that only carries the STAFF csrf cookie', () => {
    const { guard, context } = makeContext({
      method: 'POST',
      path: '/api/v1/portal/auth/change-password',
      cookies: { [STAFF_CSRF_COOKIE]: 'token-a' },
      headers: { [CSRF_HEADER]: 'token-a' },
    });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows a portal POST with a matching portal cookie/header pair', () => {
    const { guard, context } = makeContext({
      method: 'POST',
      path: '/api/v1/portal/auth/change-password',
      cookies: { [PORTAL_CSRF_COOKIE]: 'token-a' },
      headers: { [CSRF_HEADER]: 'token-a' },
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows a staff POST with a matching staff cookie/header pair (unaffected by the portal branch)', () => {
    const { guard, context } = makeContext({
      method: 'POST',
      path: '/api/v1/inquiries',
      cookies: { [STAFF_CSRF_COOKIE]: 'token-a' },
      headers: { [CSRF_HEADER]: 'token-a' },
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('skips the check entirely for a safe method (GET) regardless of cookies', () => {
    const { guard, context } = makeContext({ method: 'GET', path: '/api/v1/portal/auth/refresh' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('skips the check for a @Public() route', () => {
    const { guard, context } = makeContext({
      method: 'POST',
      path: '/api/v1/portal/auth/login',
      isPublic: true,
    });
    expect(guard.canActivate(context)).toBe(true);
  });
});
