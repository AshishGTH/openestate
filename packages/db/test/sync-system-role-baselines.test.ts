/**
 * v0.8.4 Part I: syncSystemRoleBaselines adds permissions new to a system
 * role's seed and never re-adds one an admin removed. Outcome assertions on a
 * real database, scoped to one company created here.
 *
 * Needs DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { createSystemPrismaClient } from '../src/index';
import { syncPermissions, syncSystemRoleBaselines } from '../prisma/sync-permissions';
import { deleteCompaniesSafely } from './helpers/delete-company-safely';

const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = SYSTEM_URL ? describe : describe.skip;

describeIf('v0.8.4 Part I: system-role permission sync with a per-role seed baseline', () => {
  let prisma: PrismaClient;
  let companyId: string;
  let adminRoleId: string;
  let accountsRoleId: string;
  let customRoleId: string;
  let userId: string;
  let keyToId: Map<string, string>;

  const SEED = [...new Set(ROLE_PERMISSIONS.company_admin)].sort();
  const REMOVED_BY_ADMIN = SEED[0]; // an admin took this away before the upgrade
  const NEW_IN_SEED = SEED[1]; // stands for a key a later release adds to the seed
  const EXTRA = 'portal.booking.read'; // not in company_admin's seed; an admin added it

  const held = async (roleId: string) =>
    (await prisma.rolePermission.findMany({ where: { roleId }, select: { permission: { select: { key: true } } } }))
      .map((r) => r.permission.key)
      .sort();
  const baseline = async (roleId: string) =>
    (await prisma.roleSeedBaseline.findUnique({ where: { roleId } }))?.permissionKeys.slice().sort() ?? null;
  const sync = () => syncSystemRoleBaselines(prisma, { companyId });

  beforeAll(async () => {
    prisma = createSystemPrismaClient(SYSTEM_URL!) as unknown as PrismaClient;
    await syncPermissions(prisma);
    keyToId = new Map((await prisma.permission.findMany({ select: { id: true, key: true } })).map((p) => [p.key, p.id]));
    const tag = Date.now();
    companyId = (await prisma.company.create({ data: { name: `Baseline Co ${tag}`, slug: `baseline-${tag}` } })).id;
    const role = (slug: string, isSystem: boolean, keys: string[]) =>
      prisma.role.create({
        data: { companyId, name: slug, slug, isSystem, permissions: { create: keys.map((k) => ({ permissionId: keyToId.get(k)! })) } },
      });
    adminRoleId = (await role(SYSTEM_ROLES.COMPANY_ADMIN, true, [...SEED.filter((k) => k !== REMOVED_BY_ADMIN), EXTRA])).id;
    accountsRoleId = (await role(SYSTEM_ROLES.ACCOUNTS, true, [...ROLE_PERMISSIONS.accounts])).id;
    customRoleId = (await role('custom_role', false, [SEED[2]])).id;
    // No super_admin role here: syncSuperAdminPermissions (another test file)
    // scans every company unscoped and would change it. super_admin is excluded
    // by slug in syncSystemRoleBaselines.
    userId = (
      await prisma.user.create({
        data: { companyId, roleId: adminRoleId, email: `baseline-${tag}@example.invalid`, name: 'Baseline user', passwordHash: 'x' },
      })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { companyId } });
    await prisma.rolePermission.deleteMany({ where: { role: { companyId } } });
    await prisma.role.deleteMany({ where: { companyId } });
    await prisma.auditLog.deleteMany({ where: { companyId } });
    await deleteCompaniesSafely(prisma, [companyId]);
    await prisma.$disconnect();
  });

  it('first upgrade (no baseline): adds nothing, records the seed as the baseline, reports the differences', async () => {
    const before = await held(adminRoleId);
    const r = await sync();
    expect(r.added).toBe(0);
    expect(r.baselined).toBe(2); // company_admin and accounts; never the custom role
    expect(await held(adminRoleId)).toEqual(before);
    expect(await baseline(adminRoleId)).toEqual(SEED);
    expect(await baseline(customRoleId)).toBeNull();
    const line = r.differences.find((d) => d.startsWith('company_admin'));
    expect(line).toContain(`lacks 1 seeded: ${REMOVED_BY_ADMIN}`);
    expect(line).toContain(`has 1 beyond the seed: ${EXTRA}`);
    expect(r.differences.some((d) => d.startsWith('accounts'))).toBe(false);
  });

  it('a later release: a key new to the seed arrives; the admin-removed key stays removed; the admin-added key stays', async () => {
    // Simulate a baseline taken before NEW_IN_SEED was in the seed.
    await prisma.roleSeedBaseline.update({
      where: { roleId: adminRoleId },
      data: { permissionKeys: SEED.filter((k) => k !== NEW_IN_SEED) },
    });
    await prisma.rolePermission.deleteMany({ where: { roleId: adminRoleId, permission: { key: NEW_IN_SEED } } });
    const versionBefore = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).authzVersion;

    const r = await sync();
    expect(r.added).toBe(1);
    expect(r.rolesChanged).toBe(1);
    const now = await held(adminRoleId);
    expect(now).toContain(NEW_IN_SEED);
    expect(now).not.toContain(REMOVED_BY_ADMIN);
    expect(now).toContain(EXTRA);
    expect(await baseline(adminRoleId)).toEqual(SEED);

    const audit = await prisma.auditLog.findMany({ where: { companyId, entityId: adminRoleId, action: 'ROLE_PERMS_CHANGED' } });
    expect(audit).toHaveLength(1);
    expect(audit[0].userId).toBeNull();
    expect(audit[0].after).toEqual({ added: [NEW_IN_SEED], surface: 'upgrade' });
    // The role's users' sessions end, as for an edit in the Roles screen.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).authzVersion).toBe(versionBefore + 1);
  });

  it('running again changes nothing and writes no audit row', async () => {
    const before = await held(adminRoleId);
    const r = await sync();
    expect(r).toMatchObject({ added: 0, rolesChanged: 0, baselined: 0, skipped: 0 });
    expect(await held(adminRoleId)).toEqual(before);
    expect(await prisma.auditLog.count({ where: { companyId, action: 'ROLE_PERMS_CHANGED' } })).toBe(1);
  });

  it('never revokes: a key dropped from the seed stays on the role', async () => {
    // A baseline that still lists a key the role holds but the seed no longer has.
    await prisma.roleSeedBaseline.update({ where: { roleId: adminRoleId }, data: { permissionKeys: [...SEED, EXTRA] } });
    await sync();
    expect(await held(adminRoleId)).toContain(EXTRA);
  });

  it('leaves the custom role alone', async () => {
    expect(await held(customRoleId)).toEqual([SEED[2]]);
  });
});
