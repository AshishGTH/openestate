import { PrismaClient, Prisma } from '@prisma/client';
import { ALL_PERMISSIONS, SYSTEM_ROLES, DEFAULT_LEAD_STAGES } from '@openestate/shared';

/**
 * True when `err` is Prisma's foreign-key-violation error (P2003). Both
 * sync functions below list entities (companies, super_admin roles) up
 * front, then write for each one individually — if something else deletes
 * that entity between the list and the write, the write fails this way.
 * In production this is effectively impossible (companies are never
 * hard-deleted through the app); it's a real race in this monorepo's
 * shared test database, where sibling test files create and tear down
 * their own companies concurrently with these two functions' deliberately
 * unscoped, whole-table scans. Either way, one vanished entity should
 * skip itself, not abort the sync for every entity after it — but the
 * skip must be LOUD, not silent. A silently-skipped super_admin sync is
 * close to the exact pre-pilot bug this file's own doc comments already
 * describe (a company's super_admin quietly missing permissions, with no
 * error to explain why) — the caller here is a routine upgrade run,
 * exactly the place that bug hid for four releases. Both functions below
 * log every skip with the company id, so it can't hide inside a normal
 * run's output.
 */
function isForeignKeyViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003';
}

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
export async function syncSuperAdminPermissions(
  client: PrismaClient = prisma,
): Promise<{ granted: number; skipped: number }> {
  const roles = await client.role.findMany({
    where: { slug: SYSTEM_ROLES.SUPER_ADMIN },
    select: { id: true, companyId: true },
  });
  if (roles.length === 0) return { granted: 0, skipped: 0 };

  const permissions = await client.permission.findMany({ select: { id: true, key: true } });
  let granted = 0;
  let skipped = 0;

  for (const role of roles) {
    try {
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
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        skipped++;
        console.error(
          `syncSuperAdminPermissions: SKIPPED company ${role.companyId} (super_admin role ${role.id}) — ` +
            `it vanished mid-sync, so its super_admin's permissions were NOT verified or repaired this run. ` +
            `Re-run the sync once the company's expected state is confirmed.`,
        );
        continue;
      }
      throw err;
    }
  }

  if (skipped > 0) {
    console.error(
      `syncSuperAdminPermissions: SKIPPED ${skipped} of ${roles.length} compan${roles.length === 1 ? 'y' : 'ies'} ` +
        `— see the per-company warnings above. This is NOT expected in production; do not treat this run's ` +
        `"already complete" result as covering those companies.`,
    );
  }

  return { granted, skipped };
}

/**
 * Seeds the default 6-stage pipeline for any company that has never had
 * one — gated by CompanyConfig.leadStagesSeededAt, a one-time marker,
 * NOT by "does this company currently have zero LeadStage rows."
 *
 * Row count alone can't distinguish "never seeded" from "an admin
 * deleted all six after a real seeding" — inferring from count would
 * resurrect a deliberate deletion on the very next upgrade, the exact
 * class of bug this project has already been burned by for seeded
 * masters (see the sync-permissions module doc comment above). A
 * brand-new master TYPE with zero rows is a genuinely different case
 * from a brand-new ROW in an existing master's list — there is no
 * "admin already customised this" risk the first time a company sees
 * this table at all — but only the FIRST time; the marker is what
 * keeps this function honest on every run after that.
 *
 * Called from two places: seed.ts, for the single company a fresh
 * install creates; this file's own CLI entrypoint below, for every
 * existing company on an upgrade. Same function either way — not a
 * duplicate copy, matching syncPermissions' own precedent.
 */
export async function syncLeadStages(
  client: PrismaClient = prisma,
): Promise<{ seeded: number; skipped: number }> {
  const companies = await client.company.findMany({
    select: {
      id: true,
      config: { select: { leadStagesSeededAt: true } },
    },
  });

  let seededCompanies = 0;
  let skipped = 0;
  for (const company of companies) {
    if (company.config?.leadStagesSeededAt) continue;

    try {
      await client.$transaction(async (tx) => {
        const stages = await Promise.all(
          DEFAULT_LEAD_STAGES.map((name, i) =>
            tx.leadStage.create({
              data: { companyId: company.id, name, sortOrder: i, isDefault: i === 0 },
            }),
          ),
        );
        await tx.companyConfig.upsert({
          where: { companyId: company.id },
          update: { leadStagesSeededAt: new Date() },
          create: { companyId: company.id, leadStagesSeededAt: new Date() },
        });
        return stages;
      });
      seededCompanies++;
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        skipped++;
        console.warn(`syncLeadStages: skipped company ${company.id} — it vanished mid-sync.`);
        continue;
      }
      throw err;
    }
  }

  if (skipped > 0) {
    console.warn(`syncLeadStages: skipped ${skipped} compan${skipped === 1 ? 'y' : 'ies'} that vanished mid-sync.`);
  }

  return { seeded: seededCompanies, skipped };
}

// Exit codes this CLI entrypoint uses, inspected by
// deploy/native/upgrade-native.sh (see its own comment at the call site):
//   0 — clean, nothing skipped.
//   1 — hard failure (the .catch below) — upgrade-native.sh treats this as
//       fatal and aborts BEFORE cutover, same as a migration failure.
//   2 — completed, but skipped 1+ entities that vanished mid-sync. This is
//       deliberately NOT exit 1: a skip is a narrow, near-impossible-in-
//       production, single-company edge case (see isForeignKeyViolation's
//       doc comment) — treating it as fatal would abort the ENTIRE upgrade,
//       for every company, before cutover, over one company's edge case.
//       upgrade-native.sh lets the rest of the sequence (cutover,
//       healthcheck) proceed on exit 2, then reports it loudly at the very
//       end so it can't be missed without holding back everyone else's
//       release.
if (require.main === module) {
  syncPermissions()
    .then(async (added) => {
      console.log(`Permissions synced: ${added} new, ${ALL_PERMISSIONS.length - added} already present.`);
      const { granted, skipped: superAdminSkipped } = await syncSuperAdminPermissions();
      console.log(
        granted === 0
          ? 'super_admin grants: already complete.'
          : `super_admin grants: ${granted} missing permission(s) restored.`,
      );
      const { seeded, skipped: leadStagesSkipped } = await syncLeadStages();
      console.log(
        seeded === 0
          ? 'Lead stages: already seeded for every company.'
          : `Lead stages: seeded the default pipeline for ${seeded} compan${seeded === 1 ? 'y' : 'ies'}.`,
      );

      const totalSkipped = superAdminSkipped + leadStagesSkipped;
      if (totalSkipped > 0) {
        console.error('');
        console.error('='.repeat(72));
        console.error(
          `SYNC COMPLETED WITH ${totalSkipped} SKIPPED ENTIT${totalSkipped === 1 ? 'Y' : 'IES'} — SEE WARNINGS ABOVE.`,
        );
        console.error(
          `${superAdminSkipped} super_admin role(s), ${leadStagesSkipped} compan${leadStagesSkipped === 1 ? 'y' : 'ies'} ` +
            'for lead stages. This should be near-impossible in production (companies ' +
            'are never hard-deleted through the app) — investigate before assuming this ' +
            'is routine, then re-run this sync once resolved.',
        );
        console.error('='.repeat(72));
        console.error('');
        // process.exitCode, not process.exit(2) — lets the event loop
        // drain naturally (including the .finally() disconnect below)
        // instead of terminating mid-cleanup.
        process.exitCode = 2;
      }
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
