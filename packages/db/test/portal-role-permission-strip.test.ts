/**
 * Upgrade path for portal-role permissions: the shipped migration adds the
 * broker dashboard permission and grants it to broker portal roles, then
 * stripStaffPermissionsFromPortalRoles() removes every non-portal.* grant
 * from portal roles, reports what it removed, and writes one audit row per
 * role that lost permissions. Staff roles are untouched.
 *
 * Runs the real migration.sql, not a copy. The strip is scoped to this
 * test's own company: other test files deliberately give portal roles staff
 * permissions, and an unscoped run would strip theirs mid-test.
 *
 * Needs DATABASE_URL_TEST_SYSTEM.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createSystemPrismaClient } from '../src/index';
import * as sync from '../prisma/sync-permissions';
import { deleteCompaniesSafely } from './helpers/delete-company-safely';

const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = SYSTEM_URL ? describe : describe.skip;

const MIGRATION_PATH = path.join(
  __dirname,
  '../prisma/migrations/20260927120000_portal_broker_dashboard_permission/migration.sql',
);
const DASHBOARD_PERM = 'portal.broker.dashboard.read';

describeIf('portal-role permission upgrade: migration + strip', () => {
  let prisma: PrismaClient;
  let companyId: string;
  let customerRoleId: string;
  let brokerRoleId: string;
  let staffRoleId: string;

  const keysOf = async (roleId: string) =>
    (await prisma.rolePermission.findMany({ where: { roleId }, include: { permission: true } }))
      .map((rp) => rp.permission.key)
      .sort();

  beforeAll(async () => {
    prisma = createSystemPrismaClient(SYSTEM_URL!) as unknown as PrismaClient;
    await sync.syncPermissions(prisma);

    const tag = Date.now();
    companyId = (await prisma.company.create({ data: { name: `PortalStrip Co ${tag}`, slug: `portal-strip-${tag}` } })).id;
    const perms = await prisma.permission.findMany({ select: { id: true, key: true } });
    const id = (key: string) => {
      const p = perms.find((x) => x.key === key);
      if (!p) throw new Error(`permission ${key} missing`);
      return p.id;
    };
    const makeRole = async (slug: string, isSystem: boolean, isPortal: boolean, keys: string[]) =>
      (
        await prisma.role.create({
          data: {
            companyId,
            name: slug,
            slug,
            isSystem,
            isPortal,
            permissions: { create: keys.map((k) => ({ permissionId: id(k) })) },
          },
        })
      ).id;

    // Pre-fix state. The broker role is left with isPortal = false to check
    // the migration's backfill of the flag on the seeded portal slugs.
    customerRoleId = await makeRole('customer', true, true, ['portal.booking.read', 'admin.user.read']);
    brokerRoleId = await makeRole('broker', true, false, [
      'portal.noc.action',
      'reports.broker.view',
      'inventory.unit.read',
    ]);
    staffRoleId = await makeRole(`strip-staff-${tag}`, false, false, [
      'reports.broker.view',
      'inventory.unit.read',
      'admin.user.read',
    ]);
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { companyId } });
    await prisma.role.deleteMany({ where: { companyId } });
    await deleteCompaniesSafely(prisma, [companyId]);
    await prisma.$disconnect();
  });

  it('the migration file exists', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('migration then strip: portal roles hold only portal.*, broker gains the dashboard permission, staff untouched, audited', async () => {
    const statements = readFileSync(MIGRATION_PATH, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(/;\s*(?:\n|$)/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) await prisma.$executeRawUnsafe(statement);

    expect((await prisma.role.findUniqueOrThrow({ where: { id: brokerRoleId } })).isPortal).toBe(true);

    const result = await sync.stripStaffPermissionsFromPortalRoles(prisma, { companyId });
    expect(result).toEqual({ removed: 3, roles: 2 });

    expect(await keysOf(customerRoleId)).toEqual(['portal.booking.read']);
    expect(await keysOf(brokerRoleId)).toEqual([DASHBOARD_PERM, 'portal.noc.action'].sort());
    expect(await keysOf(staffRoleId)).toEqual(['admin.user.read', 'inventory.unit.read', 'reports.broker.view']);

    const audits = await prisma.auditLog.findMany({
      where: { companyId, action: 'PORTAL_PERMS_REMOVED' },
      orderBy: { entityId: 'asc' },
    });
    expect(audits).toHaveLength(2);
    const byRole = new Map(audits.map((a) => [a.entityId, a]));
    for (const a of audits) {
      expect(a.userId).toBeNull();
      expect(a.entityType).toBe('Role');
      expect(a.after).toEqual({ surface: 'upgrade' });
    }
    expect(byRole.get(customerRoleId)?.before).toEqual({ removed: ['admin.user.read'] });
    expect(byRole.get(brokerRoleId)?.before).toEqual({ removed: ['inventory.unit.read', 'reports.broker.view'] });
  });

  it('a second run removes nothing and writes no audit row', async () => {
    const result = await sync.stripStaffPermissionsFromPortalRoles(prisma, { companyId });
    expect(result).toEqual({ removed: 0, roles: 0 });
    expect(await prisma.auditLog.count({ where: { companyId, action: 'PORTAL_PERMS_REMOVED' } })).toBe(2);
  });
});
