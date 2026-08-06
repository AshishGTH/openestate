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
  projectName: string;
  unitNumber: string;
  // Only set when opts.withPricingMasters is passed (scenario 4) — the
  // other scenarios have no use for a PLC type/GST-rated charge type.
  plcTypeName?: string;
  chargeTypeName?: string;
  chargeTypeGstRatePercent?: number;
}

const rnd = () => Math.random().toString(36).slice(2, 8);

export async function seedE2eFixture(
  databaseUrlSystem: string,
  opts: { forcePasswordChange?: boolean; withPricingMasters?: boolean } = {},
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
        // isIntraStateSupply() throws (not silently defaults to
        // intra-state) when either side's state code is missing — every
        // scenario here books a unit, so this must be set or every
        // booking attempt 400s. Matches
        // apps/api/test/helpers/postsales-harness.ts's own default.
        gstStateCode: '09',
        companyGstin: '09ABCDE1234F1Z5',
      },
    });

    // Minimal inventory for scenario 3's booking flow — direct Prisma
    // writes, not through the Inventory UI, since inventory creation is
    // out of scope for these three scenarios (mirrors
    // apps/api/test/helpers/postsales-harness.ts's seedCompany/makeUnit).
    // areaLocation gives the project a place-of-supply state code — the
    // other half of what isIntraStateSupply() now requires.
    const areaLocation = await prisma.areaLocation.create({
      data: { companyId: company.id, name: `E2E Area ${tag}`, stateCode: '09' },
    });
    const project = await prisma.project.create({
      data: { companyId: company.id, name: `E2E Project ${tag}`, code: `E2E-${tag}`, areaLocationId: areaLocation.id },
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

    let plcTypeName: string | undefined;
    let chargeTypeName: string | undefined;
    let chargeTypeGstRatePercent: number | undefined;
    if (opts.withPricingMasters) {
      const plcType = await prisma.plcType.create({ data: { companyId: company.id, name: `Park Facing ${tag}` } });
      plcTypeName = plcType.name;

      // A GST rate distinct from the base line's (which nothing sets —
      // there's no rate picker in the wizard today) so the assigned
      // charge is taxed on ITS OWN rate, not left untaxed alongside an
      // untaxed base line — exactly the scenario that motivated exposing
      // ChargeType.gstRateId at all.
      chargeTypeGstRatePercent = 5;
      const gstRate = await prisma.gstRate.create({
        data: { companyId: company.id, rate: chargeTypeGstRatePercent, description: `GST ${chargeTypeGstRatePercent}%`, effectiveFrom: new Date('2019-04-01') },
      });
      const chargeType = await prisma.chargeType.create({
        data: { companyId: company.id, name: `IFMS ${tag}`, gstRateId: gstRate.id },
      });
      chargeTypeName = chargeType.name;
    }

    return {
      companyId: company.id,
      adminEmail,
      adminPassword,
      projectName: project.name,
      unitNumber,
      plcTypeName,
      chargeTypeName,
      chargeTypeGstRatePercent,
    };
  } finally {
    await prisma.$disconnect();
  }
}
