/**
 * Regression test for a real upgrade-path bug found on the 192.168.1.2
 * verification VM while taking it from v0.1.2 to v0.2.3.
 *
 * `permissions` had all 142 rows (syncPermissions did its job), but
 * `super_admin` on companies that predated v0.2.0 still held only 140 —
 * missing exactly the two that release added
 * (`inventory.unit.plc-manage` / `inventory.unit.charge-manage`). The
 * PLC pricing UI those gate was therefore unreachable on every upgraded
 * install, for the most privileged role in the product, with no error
 * explaining why.
 *
 * `syncSuperAdminPermissions` closes it for super_admin ONLY — see that
 * function's own doc comment and CLAUDE.md for why the narrowing stops
 * there. These tests pin both halves: the grant happens for super_admin,
 * and it provably does NOT happen for company_admin or a custom role.
 *
 * Needs DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { createSystemPrismaClient } from '../src/index';
import { syncPermissions, syncSuperAdminPermissions } from '../prisma/sync-permissions';

const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = SYSTEM_URL ? describe : describe.skip;

describeIf('syncSuperAdminPermissions: upgrade-path grant repair', () => {
  let prisma: PrismaClient;
  let companyId: string;
  let superAdminRoleId: string;
  let companyAdminRoleId: string;
  let customRoleId: string;

  // The two v0.2.0 keys whose absence was the actual production bug.
  const V020_KEYS = ['inventory.unit.plc-manage', 'inventory.unit.charge-manage'];

  beforeAll(async () => {
    prisma = createSystemPrismaClient(SYSTEM_URL!) as unknown as PrismaClient;
    await syncPermissions(prisma);

    const tag = Date.now();
    const company = await prisma.company.create({
      data: { name: `SyncPerm Co ${tag}`, slug: `syncperm-${tag}` },
    });
    companyId = company.id;

    const allPerms = await prisma.permission.findMany({ select: { id: true, key: true } });
    const idsExcept = (excludeKeys: string[]) =>
      allPerms.filter((p) => !excludeKeys.includes(p.key)).map((p) => p.id);

    // Reproduce the exact pre-upgrade shape: super_admin holding
    // everything EXCEPT the keys a later release introduced.
    const superAdmin = await prisma.role.create({
      data: {
        companyId,
        name: 'Super Admin',
        slug: SYSTEM_ROLES.SUPER_ADMIN,
        isSystem: true,
        permissions: { create: idsExcept(V020_KEYS).map((permissionId) => ({ permissionId })) },
      },
    });
    superAdminRoleId = superAdmin.id;

    // A deliberately NARROWED company_admin — this is the case the
    // original "never touch role_permissions" decision protects, and it
    // must stay narrowed after the sync runs.
    const companyAdmin = await prisma.role.create({
      data: {
        companyId,
        name: 'Company Admin',
        slug: SYSTEM_ROLES.COMPANY_ADMIN,
        isSystem: true,
        permissions: { create: allPerms.slice(0, 5).map((p) => ({ permissionId: p.id })) },
      },
    });
    companyAdminRoleId = companyAdmin.id;

    const custom = await prisma.role.create({
      data: {
        companyId,
        name: 'Site Visit Coordinator',
        slug: `site-visit-coordinator-${tag}`,
        isSystem: false,
        permissions: { create: allPerms.slice(0, 3).map((p) => ({ permissionId: p.id })) },
      },
    });
    customRoleId = custom.id;
  });

  afterAll(async () => {
    await prisma.rolePermission.deleteMany({
      where: { roleId: { in: [superAdminRoleId, companyAdminRoleId, customRoleId] } },
    });
    await prisma.role.deleteMany({ where: { companyId } });
    await prisma.company.delete({ where: { id: companyId } });
    await prisma.$disconnect();
  });

  async function grantedKeys(roleId: string): Promise<string[]> {
    const rows = await prisma.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: { key: true } } },
    });
    return rows.map((r) => r.permission.key).sort();
  }

  it('reproduces the bug first: super_admin is missing the keys a later release added', async () => {
    const before = await grantedKeys(superAdminRoleId);
    for (const key of V020_KEYS) {
      expect(before).not.toContain(key);
    }
    expect(before.length).toBe(ALL_PERMISSIONS.length - V020_KEYS.length);
  });

  it('grants super_admin every permission, so an upgraded install can actually reach new features', async () => {
    const granted = await syncSuperAdminPermissions(prisma);
    expect(granted).toBeGreaterThanOrEqual(V020_KEYS.length);

    const after = await grantedKeys(superAdminRoleId);
    for (const key of V020_KEYS) {
      expect(after).toContain(key);
    }
    // The real assertion: super_admin's contract is ALL of them.
    expect(after.length).toBe(ALL_PERMISSIONS.length);
    expect(after).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('is idempotent — a second run grants nothing and changes nothing', async () => {
    const before = await grantedKeys(superAdminRoleId);
    const granted = await syncSuperAdminPermissions(prisma);
    expect(granted).toBe(0);
    expect(await grantedKeys(superAdminRoleId)).toEqual(before);
  });

  it('does NOT widen a deliberately narrowed company_admin', async () => {
    const keys = await grantedKeys(companyAdminRoleId);
    expect(keys.length).toBe(5);
    expect(keys.length).toBeLessThan(ALL_PERMISSIONS.length);
  });

  it('does NOT widen a custom role', async () => {
    const keys = await grantedKeys(customRoleId);
    expect(keys.length).toBe(3);
  });

  it('returns 0 when the install has no super_admin role at all', async () => {
    await prisma.rolePermission.deleteMany({ where: { roleId: superAdminRoleId } });
    await prisma.role.delete({ where: { id: superAdminRoleId } });
    expect(await syncSuperAdminPermissions(prisma)).toBe(0);

    // Recreate so afterAll's cleanup stays uniform.
    const recreated = await prisma.role.create({
      data: { companyId, name: 'Super Admin', slug: SYSTEM_ROLES.SUPER_ADMIN, isSystem: true },
    });
    superAdminRoleId = recreated.id;
  });
});
