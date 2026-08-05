import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS } from '@openestate/shared';

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
 *  - Deliberately NOT extended to roles or seeded masters. Both are
 *    per-company data an admin may have already renamed, deactivated, or
 *    reassigned — silently injecting new rows into every existing
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

if (require.main === module) {
  syncPermissions()
    .then((added) => {
      console.log(`Permissions synced: ${added} new, ${ALL_PERMISSIONS.length - added} already present.`);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
