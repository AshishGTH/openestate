/**
 * RBAC: PermissionsGuard returns 403 for insufficient permissions (f).
 *
 * Unit test — no Postgres needed. Tests the guard logic directly.
 */
import { describe, it, expect } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../src/auth/guards/permissions.guard';
import type { JwtPayload } from '@openestate/shared';

function makeContext(
  user: JwtPayload | undefined,
  requiredPerms: string[] | undefined,
) {
  const reflector = new Reflector();
  const guard = new PermissionsGuard(reflector);

  const mockContext = {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  };

  // Override reflector to return our required perms
  reflector.getAllAndOverride = () => requiredPerms as never;

  return { guard, context: mockContext as never };
}

describe('PermissionsGuard (f)', () => {
  const baseUser: JwtPayload = {
    sub: 'user-1',
    companyId: 'company-1',
    email: 'test@test.com',
    roleSlug: 'sales_executive',
    permissions: ['presales.inquiry.read', 'presales.inquiry.create'],
  };

  it('allows access when user has all required permissions', () => {
    const { guard, context } = makeContext(baseUser, ['presales.inquiry.read']);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows access when no permissions are required', () => {
    const { guard, context } = makeContext(baseUser, undefined);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows access with empty required permissions array', () => {
    const { guard, context } = makeContext(baseUser, []);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('throws ForbiddenException (403) when user lacks a required permission', () => {
    const { guard, context } = makeContext(baseUser, ['admin.user.read']);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when user has some but not all required permissions', () => {
    const { guard, context } = makeContext(baseUser, [
      'presales.inquiry.read',
      'admin.user.read',
    ]);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('returns false when no user is on the request', () => {
    const { guard, context } = makeContext(undefined, ['admin.user.read']);
    expect(guard.canActivate(context)).toBe(false);
  });

  it('user with all admin permissions passes admin guard', () => {
    const adminUser: JwtPayload = {
      ...baseUser,
      roleSlug: 'super_admin',
      permissions: [
        'admin.user.read',
        'admin.user.create',
        'admin.user.update',
        'admin.user.deactivate',
        'admin.role.read',
        'admin.role.create',
      ],
    };
    const { guard, context } = makeContext(adminUser, [
      'admin.user.read',
      'admin.user.create',
    ]);
    expect(guard.canActivate(context)).toBe(true);
  });
});
