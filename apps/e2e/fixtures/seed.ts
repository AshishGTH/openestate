// Deliberately not imported from apps/api/test/helpers/postsales-harness.ts
// or packages/db/prisma/seed.ts — neither is a published package export,
// so a cross-package relative import would reach into another package's
// private test/script directory. This mirrors their shape instead (same
// company/role/user/inventory pattern used throughout this project's test
// suite) at the small cost of some duplication.
import { createSystemPrismaClient } from '@openestate/db';
import { ALL_PERMISSIONS, SYSTEM_ROLES, ROLE_PERMISSIONS, ROLE_DISPLAY_NAMES } from '@openestate/shared';
import * as argon2 from '@node-rs/argon2';

export interface E2eFixture {
  companyId: string;
  adminEmail: string;
  adminPassword: string;
}

const rnd = () => Math.random().toString(36).slice(2, 8);

export async function seedE2eFixture(
  databaseUrlSystem: string,
  opts: { forcePasswordChange?: boolean } = {},
): Promise<E2eFixture> {
  const prisma = createSystemPrismaClient(databaseUrlSystem);
  const tag = `${Date.now()}-${rnd()}`;

  try {
    // Permissions are global, not company-scoped — upsert so a rerun
    // against an already-seeded disposable DB (e.g. re-running the suite
    // without tearing the test DB down between local iterations) doesn't
    // fail on the unique constraint, matching packages/db/prisma/seed.ts.
    for (const key of ALL_PERMISSIONS) {
      await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await prisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p) => [p.key, p.id]));

    const company = await prisma.company.create({
      data: { name: `E2E Harness ${tag}`, slug: `e2e-harness-${tag}` },
    });

    const role = await prisma.role.create({
      data: {
        companyId: company.id,
        name: ROLE_DISPLAY_NAMES[SYSTEM_ROLES.SUPER_ADMIN],
        slug: SYSTEM_ROLES.SUPER_ADMIN,
        isSystem: true,
      },
    });
    const rolePermData = ROLE_PERMISSIONS[SYSTEM_ROLES.SUPER_ADMIN]
      .map((key) => permByKey.get(key))
      .filter((id): id is string => !!id)
      .map((permissionId) => ({ roleId: role.id, permissionId }));
    if (rolePermData.length > 0) {
      await prisma.rolePermission.createMany({ data: rolePermData });
    }

    const adminEmail = `admin-${tag}@e2e-harness.test`;
    const adminPassword = 'E2eHarness#Pass1';
    const adminHash = await argon2.hash(adminPassword, { algorithm: argon2.Algorithm.Argon2id });
    await prisma.user.create({
      data: {
        companyId: company.id,
        email: adminEmail,
        name: 'E2E Admin',
        passwordHash: adminHash,
        roleId: role.id,
        // Real installs always create staff users this way (see
        // packages/db/prisma/seed.ts) — only auth-2fa.spec.ts actually
        // needs to exercise the gate, so every other scenario opts out to
        // stay focused on what it's testing.
        forcePasswordChange: opts.forcePasswordChange ?? false,
      },
    });

    await prisma.companyConfig.create({
      data: {
        companyId: company.id,
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        fyStartMonth: 4,
        dateFormat: 'DD-MM-YYYY',
        // Zero, not the real-world default — isolates scenario 3's
        // before/after Collection Summary delta to the receipt amount
        // alone, with no separate bounce-charge line to account for.
        chequeBounceChargePaise: BigInt(0),
      },
    });

    // Minimal inventory for scenario 3's booking flow — direct Prisma
    // writes, not through the Inventory UI, since inventory creation is
    // out of scope for these three scenarios (mirrors
    // apps/api/test/helpers/postsales-harness.ts's seedCompany/makeUnit).
    const project = await prisma.project.create({
      data: { companyId: company.id, name: `E2E Project ${tag}`, code: `E2E-${tag}` },
    });
    const tower = await prisma.tower.create({
      data: { companyId: company.id, projectId: project.id, name: 'Tower 1', code: 'T1' },
    });
    const floor = await prisma.floor.create({
      data: { companyId: company.id, towerId: tower.id, name: 'Floor 1', floorNumber: 1 },
    });
    const unitNumber = `E2E-${tag}`;
    await prisma.unit.create({
      data: {
        companyId: company.id,
        floorId: floor.id,
        number: unitNumber,
        status: 'AVAILABLE',
        baseRatePaise: BigInt(50_00_000_00), // ₹50,00,000 — plausible, overridden per-scenario anyway
      },
    });

    return { companyId: company.id, adminEmail, adminPassword };
  } finally {
    await prisma.$disconnect();
  }
}
