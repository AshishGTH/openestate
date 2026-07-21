/**
 * Phase 2 tenant isolation integration tests.
 *
 * Proves that RLS isolates units and unit_rate_revisions across tenants.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  createTenantPrismaClient,
  createSystemPrismaClient,
  withTenantTx,
  runWithTenant,
} from '../src/index';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;

const shouldRun = !!(APP_URL && SYSTEM_URL);
const describeIf = shouldRun ? describe : describe.skip;

describeIf('Inventory tenant isolation (RLS)', () => {
  let systemPrisma: PrismaClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;

  let companyAId: string;
  let companyBId: string;
  let roleAId: string;
  let roleBId: string;
  let userAId: string;
  let projectAId: string;
  let projectBId: string;
  let towerAId: string;
  let towerBId: string;
  let floorAId: string;
  let floorBId: string;
  let unitAId: string;
  let unitBId: string;

  beforeAll(async () => {
    systemPrisma = createSystemPrismaClient(SYSTEM_URL!);
    tenantPrisma = createTenantPrismaClient(APP_URL!);

    const companyA = await systemPrisma.company.create({
      data: { name: 'Inv Co A', slug: `inv-a-${Date.now()}` },
    });
    const companyB = await systemPrisma.company.create({
      data: { name: 'Inv Co B', slug: `inv-b-${Date.now()}` },
    });
    companyAId = companyA.id;
    companyBId = companyB.id;

    const rA = await systemPrisma.role.create({
      data: { companyId: companyAId, name: 'Admin', slug: 'admin', isSystem: true },
    });
    const rB = await systemPrisma.role.create({
      data: { companyId: companyBId, name: 'Admin', slug: 'admin', isSystem: true },
    });
    roleAId = rA.id;
    roleBId = rB.id;

    const uA = await systemPrisma.user.create({
      data: { companyId: companyAId, email: 'inv-a@test', passwordHash: 'x', name: 'A', roleId: roleAId },
    });
    userAId = uA.id;
    await systemPrisma.user.create({
      data: { companyId: companyBId, email: 'inv-b@test', passwordHash: 'x', name: 'B', roleId: roleBId },
    });

    const pA = await systemPrisma.project.create({
      data: { companyId: companyAId, name: 'Project A', code: `PA-${Date.now()}` },
    });
    const pB = await systemPrisma.project.create({
      data: { companyId: companyBId, name: 'Project B', code: `PB-${Date.now()}` },
    });
    projectAId = pA.id;
    projectBId = pB.id;

    const tA = await systemPrisma.tower.create({
      data: { companyId: companyAId, projectId: projectAId, name: 'Tower A', code: 'TA' },
    });
    const tB = await systemPrisma.tower.create({
      data: { companyId: companyBId, projectId: projectBId, name: 'Tower B', code: 'TB' },
    });
    towerAId = tA.id;
    towerBId = tB.id;

    const fA = await systemPrisma.floor.create({
      data: { companyId: companyAId, towerId: towerAId, name: 'Floor 1', floorNumber: 1 },
    });
    const fB = await systemPrisma.floor.create({
      data: { companyId: companyBId, towerId: towerBId, name: 'Floor 1', floorNumber: 1 },
    });
    floorAId = fA.id;
    floorBId = fB.id;

    const unitA = await systemPrisma.unit.create({
      data: { companyId: companyAId, floorId: floorAId, number: 'A-0101', baseRatePaise: BigInt(500000) },
    });
    const unitB = await systemPrisma.unit.create({
      data: { companyId: companyBId, floorId: floorBId, number: 'B-0101', baseRatePaise: BigInt(600000) },
    });
    unitAId = unitA.id;
    unitBId = unitB.id;

    await systemPrisma.unitRateRevision.create({
      data: {
        companyId: companyAId,
        unitId: unitAId,
        ratePaise: BigInt(500000),
        effectiveFrom: new Date('2025-01-01'),
        reason: 'Initial rate',
        createdById: userAId,
      },
    });
    await systemPrisma.unitRateRevision.create({
      data: {
        companyId: companyBId,
        unitId: unitBId,
        ratePaise: BigInt(600000),
        effectiveFrom: new Date('2025-01-01'),
        reason: 'Initial rate',
      },
    });
  });

  afterAll(async () => {
    await systemPrisma.unitRateRevision.deleteMany({
      where: { companyId: { in: [companyAId, companyBId] } },
    });
    await systemPrisma.unit.deleteMany({
      where: { companyId: { in: [companyAId, companyBId] } },
    });
    await systemPrisma.floor.deleteMany({
      where: { companyId: { in: [companyAId, companyBId] } },
    });
    await systemPrisma.tower.deleteMany({
      where: { companyId: { in: [companyAId, companyBId] } },
    });
    await systemPrisma.project.deleteMany({
      where: { companyId: { in: [companyAId, companyBId] } },
    });
    await systemPrisma.user.deleteMany({
      where: { companyId: { in: [companyAId, companyBId] } },
    });
    await systemPrisma.role.deleteMany({
      where: { companyId: { in: [companyAId, companyBId] } },
    });
    await systemPrisma.$executeRaw`
      DELETE FROM audit_logs WHERE company_id IN (${companyAId}::uuid, ${companyBId}::uuid)
    `;
    await systemPrisma.company.deleteMany({
      where: { id: { in: [companyAId, companyBId] } },
    });
    await systemPrisma.$disconnect();
    await (tenantPrisma as PrismaClient).$disconnect();
  });

  it('company A tenant context sees only company A units', async () => {
    const units = await runWithTenant({ companyId: companyAId }, () =>
      withTenantTx(tenantPrisma, companyAId, (tx) => tx.unit.findMany()),
    );
    expect(units).toHaveLength(1);
    expect(units[0].number).toBe('A-0101');
  });

  it('company B tenant context sees only company B units', async () => {
    const units = await runWithTenant({ companyId: companyBId }, () =>
      withTenantTx(tenantPrisma, companyBId, (tx) => tx.unit.findMany()),
    );
    expect(units).toHaveLength(1);
    expect(units[0].number).toBe('B-0101');
  });

  it('company A cannot read company B units via raw SQL within tenant tx', async () => {
    const count = await runWithTenant({ companyId: companyAId }, () =>
      withTenantTx(tenantPrisma, companyAId, async (tx) => {
        const rows = await (tx as PrismaClient).$queryRaw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM units WHERE company_id = ${companyBId}::uuid
        `;
        return Number(rows[0].n);
      }),
    );
    expect(count).toBe(0);
  });

  it('company A tenant context sees only company A rate revisions', async () => {
    const revisions = await runWithTenant({ companyId: companyAId }, () =>
      withTenantTx(tenantPrisma, companyAId, (tx) =>
        tx.unitRateRevision.findMany(),
      ),
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0].unitId).toBe(unitAId);
  });

  it('company A cannot read company B rate revisions via raw SQL', async () => {
    const count = await runWithTenant({ companyId: companyAId }, () =>
      withTenantTx(tenantPrisma, companyAId, async (tx) => {
        const rows = await (tx as PrismaClient).$queryRaw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM unit_rate_revisions WHERE company_id = ${companyBId}::uuid
        `;
        return Number(rows[0].n);
      }),
    );
    expect(count).toBe(0);
  });
});
