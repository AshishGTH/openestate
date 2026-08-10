import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';

const prisma = new PrismaClient();

/**
 * Adds any PERMISSIONS constant that doesn't have a row yet — nothing
 * else. Safe to run on every upgrade of an EXISTING install, unlike the
 * rest of seed.ts:
 *
 *  - Permission has exactly two columns (id, key) and no company scope —
 *    there is nothing about a permission an admin could have customised,
 *    so upserting is unconditionally safe, on a fresh install or the
 *    thousandth upgrade of an old one.
 *  - Deliberately NOT extended to seeded masters, nor to the
 *    role_permissions of any role EXCEPT super_admin (see below). Both
 *    are per-company data an admin may have already renamed, deactivated,
 *    or reassigned — silently injecting new rows into every existing
 *    company's live master/role lists on every upgrade would be a real
 *    correctness bug of its own, not a fix. A future release that adds a
 *    new default master type needs a deliberate, opt-in per-company
 *    decision, not an automatic sync here.
 *
 * Exists as its own script (seed.ts imports and calls it, not a
 * duplicate copy) because seed.ts's OWN permission-upsert loop is
 * unreachable on any install that already has a company — which is
 * every real install after its first boot — so seed.ts alone never
 * delivers a later release's new PERMISSIONS constants to an existing
 * install. See CLAUDE.md's v0.2.0 upgrade-path entry for the bug this
 * fixes: a release that adds a permission and ships a UI gated on it
 * upgrades cleanly and heals nothing — no role can be granted a
 * permission row that was never inserted.
 */
export async function syncPermissions(client: PrismaClient = prisma): Promise<number> {
  let added = 0;
  for (const key of ALL_PERMISSIONS) {
    const before = await client.permission.findUnique({ where: { key } });
    if (!before) added++;
    await client.permission.upsert({ where: { key }, update: {}, create: { key } });
  }
  return added;
}

/**
 * Grants any permission super_admin is missing, for every company.
 *
 * This is the ONE role whose role_permissions this script touches, and
 * the exception is narrow on purpose. `ROLE_PERMISSIONS.super_admin` is
 * literally `Object.values(PERMISSIONS)` (packages/shared/src/roles.ts)
 * — "every permission that exists" IS its definition, not a default
 * someone picked. So a super_admin missing a key isn't a customisation
 * to respect, it's drift from its own contract.
 *
 * Found on a real v0.1.2 -> v0.2.3 upgrade: `permissions` had all 142
 * rows (this script's original job worked), but super_admin on
 * pre-existing companies still had only 140 — missing exactly the two
 * v0.2.0 added (`inventory.unit.plc-manage`/`charge-manage`). The PLC
 * pricing UI those gate was therefore unreachable for every company
 * that existed before that release, on every upgraded install, with no
 * error to explain why. Adding a permission and shipping a UI gated on
 * it silently did nothing for the most privileged role in the product.
 *
 * Every OTHER role (company_admin, sales_manager, custom roles) is
 * still deliberately untouched — those are genuine composition choices
 * an admin may have narrowed, and an upgrade must not widen them. An
 * admin grants new permissions to those through the Roles UI, which
 * v0.2.0 unblocked (see CLAUDE.md's RolesService.update fix).
 */
export async function syncSuperAdminPermissions(client: PrismaClient = prisma): Promise<number> {
  const roles = await client.role.findMany({
    where: { slug: SYSTEM_ROLES.SUPER_ADMIN },
    select: { id: true },
  });
  if (roles.length === 0) return 0;

  const permissions = await client.permission.findMany({ select: { id: true, key: true } });
  let granted = 0;

  for (const role of roles) {
    const existing = await client.rolePermission.findMany({
      where: { roleId: role.id },
      select: { permissionId: true },
    });
    const have = new Set(existing.map((rp) => rp.permissionId));
    const missing = permissions.filter((p) => !have.has(p.id));
    if (missing.length === 0) continue;

    await client.rolePermission.createMany({
      data: missing.map((p) => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true,
    });
    granted += missing.length;
  }

  return granted;
}

if (require.main === module) {
  syncPermissions()
    .then(async (added) => {
      console.log(`Permissions synced: ${added} new, ${ALL_PERMISSIONS.length - added} already present.`);
      const granted = await syncSuperAdminPermissions();
      console.log(
        granted === 0
          ? 'super_admin grants: already complete.'
          : `super_admin grants: ${granted} missing permission(s) restored.`,
      );
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
