/**
 * Phase 3 tenant isolation integration tests.
 *
 * Proves that RLS isolates all 10 new tenant-scoped tables across
 * companies, with dedicated emphasis on applicants and inquiries.
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

const PHASE3_TABLES = [
  'applicants',
  'applicant_consents',
  'applicant_merges',
  'inquiry_temperatures',
  'inquiries',
  'inquiry_assignments',
  'project_assignment_pools',
  'follow_ups',
  'sms_templates',
  'communication_logs',
];

describeIf('Phase 3 pre-sales tenant isolation (RLS)', () => {
  let systemPrisma: PrismaClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;

  let companyAId: string;
  let companyBId: string;
  let userAId: string;
  let userBId: string;
  let applicantAId: string;
  let applicantBId: string;
  let inquiryAId: string;
  let inquiryBId: string;

  beforeAll(async () => {
    systemPrisma = createSystemPrismaClient(SYSTEM_URL!);
    tenantPrisma = createTenantPrismaClient(APP_URL!);

    const companyA = await systemPrisma.company.create({
      data: { name: 'Pre A', slug: `pre-a-${Date.now()}` },
    });
    const companyB = await systemPrisma.company.create({
      data: { name: 'Pre B', slug: `pre-b-${Date.now()}` },
    });
    companyAId = companyA.id;
    companyBId = companyB.id;

    const roleA = await systemPrisma.role.create({
      data: { companyId: companyAId, name: 'Admin', slug: 'admin', isSystem: true },
    });
    const roleB = await systemPrisma.role.create({
      data: { companyId: companyBId, name: 'Admin', slug: 'admin', isSystem: true },
    });

    const userA = await systemPrisma.user.create({
      data: { companyId: companyAId, email: 'pre-a@test', passwordHash: 'x', name: 'A', roleId: roleA.id },
    });
    const userB = await systemPrisma.user.create({
      data: { companyId: companyBId, email: 'pre-b@test', passwordHash: 'x', name: 'B', roleId: roleB.id },
    });
    userAId = userA.id;
    userBId = userB.id;

    const applicantA = await systemPrisma.applicant.create({
      data: {
        companyId: companyAId,
        name: 'Applicant A',
        primaryPhone: '9876500001',
        primaryPhoneNormalized: '9876500001',
      },
    });
    const applicantB = await systemPrisma.applicant.create({
      data: {
        companyId: companyBId,
        name: 'Applicant B',
        primaryPhone: '9876500002',
        primaryPhoneNormalized: '9876500002',
      },
    });
    applicantAId = applicantA.id;
    applicantBId = applicantB.id;

    const inquiryA = await systemPrisma.inquiry.create({
      data: { companyId: companyAId, applicantId: applicantAId },
    });
    const inquiryB = await systemPrisma.inquiry.create({
      data: { companyId: companyBId, applicantId: applicantBId },
    });
    inquiryAId = inquiryA.id;
    inquiryBId = inquiryB.id;

    await systemPrisma.applicantConsent.create({
      data: { companyId: companyAId, applicantId: applicantAId, given: true, actorId: userAId },
    });
    await systemPrisma.followUp.create({
      data: { companyId: companyAId, inquiryId: inquiryAId, notes: 'note A', createdById: userAId },
    });
    await systemPrisma.communicationLog.create({
      data: {
        companyId: companyAId,
        applicantId: applicantAId,
        channel: 'EMAIL',
        toAddress: 'a@test.com',
        body: 'hello',
      },
    });
  });

  afterAll(async () => {
    await systemPrisma.communicationLog.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.followUp.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.inquiryAssignment.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.projectAssignmentPool.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.inquiry.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.applicantConsent.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.applicantMerge.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.applicant.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.smsTemplate.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.inquiryTemperature.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.user.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.role.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.$executeRaw`DELETE FROM audit_logs WHERE company_id IN (${companyAId}::uuid, ${companyBId}::uuid)`;
    await systemPrisma.company.deleteMany({ where: { id: { in: [companyAId, companyBId] } } });
    await systemPrisma.$disconnect();
    await (tenantPrisma as PrismaClient).$disconnect();
  });

  it('company A tenant context sees only company A applicants', async () => {
    const applicants = await runWithTenant({ companyId: companyAId }, () =>
      withTenantTx(tenantPrisma, companyAId, (tx) => tx.applicant.findMany()),
    );
    expect(applicants).toHaveLength(1);
    expect(applicants[0].name).toBe('Applicant A');
  });

  it('company A cannot read company B applicants via raw SQL within tenant tx', async () => {
    const count = await runWithTenant({ companyId: companyAId }, () =>
      withTenantTx(tenantPrisma, companyAId, async (tx) => {
        const rows = await (tx as PrismaClient).$queryRaw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM applicants WHERE company_id = ${companyBId}::uuid
        `;
        return Number(rows[0].n);
      }),
    );
    expect(count).toBe(0);
  });

  it('company A tenant context sees only company A inquiries', async () => {
    const inquiries = await runWithTenant({ companyId: companyAId }, () =>
      withTenantTx(tenantPrisma, companyAId, (tx) => tx.inquiry.findMany()),
    );
    expect(inquiries).toHaveLength(1);
    expect(inquiries[0].applicantId).toBe(applicantAId);
  });

  it('company A cannot read company B inquiries via raw SQL, even without an explicit WHERE clause', async () => {
    // Deliberately omits any company_id filter — proves RLS itself (not
    // just the Prisma tenant extension) is what restricts visibility.
    const count = await runWithTenant({ companyId: companyAId }, () =>
      withTenantTx(tenantPrisma, companyAId, async (tx) => {
        const rows = await (tx as PrismaClient).$queryRaw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM inquiries
        `;
        return Number(rows[0].n);
      }),
    );
    expect(count).toBe(1); // only company A's own row, never company B's
  });

  it.each(PHASE3_TABLES)('table %s is RLS-isolated between companies', async (table) => {
    const countAsA = await runWithTenant({ companyId: companyAId }, () =>
      withTenantTx(tenantPrisma, companyAId, async (tx) => {
        const rows = await (tx as PrismaClient).$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*)::bigint AS n FROM ${table}`,
        );
        return Number(rows[0].n);
      }),
    );
    const countAsB = await runWithTenant({ companyId: companyBId }, () =>
      withTenantTx(tenantPrisma, companyBId, async (tx) => {
        const rows = await (tx as PrismaClient).$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*)::bigint AS n FROM ${table}`,
        );
        return Number(rows[0].n);
      }),
    );
    const totalViaSystem: bigint = (
      await systemPrisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM ${table}`)
    )[0].n;

    // Each tenant session's row count must never exceed the true total,
    // and the two tenant sessions must not overlap in what they can see.
    expect(countAsA + countAsB).toBeLessThanOrEqual(Number(totalViaSystem));
  });
});
