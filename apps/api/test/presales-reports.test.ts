/**
 * Ageing bucket math against seeded fixtures with known dates, and funnel
 * report reconciliation against raw counts on ~200 seeded inquiries.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSystemPrismaClient } from '@openestate/db';
import type { Clock } from '@openestate/shared';
import { ReportsService } from '../src/presales/reports.service';

const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const shouldRun = !!SYSTEM_URL;
const describeIf = shouldRun ? describe : describe.skip;

const FROZEN_NOW = new Date('2026-07-21T12:00:00.000Z');
const frozenClock: Clock = { now: () => FROZEN_NOW };

function daysAgo(n: number): Date {
  return new Date(FROZEN_NOW.getTime() - n * 86_400_000);
}

describeIf('Presales reports: ageing buckets + funnel reconciliation', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let reportsService: ReportsService;
  let companyId: string;
  let applicantId: string;

  beforeAll(async () => {
    systemPrisma = createSystemPrismaClient(SYSTEM_URL!);
    reportsService = new ReportsService(systemPrisma, frozenClock);

    const company = await systemPrisma.company.create({
      data: { name: 'Reports Test Co', slug: `reports-test-${Date.now()}` },
    });
    companyId = company.id;
    const applicant = await systemPrisma.applicant.create({
      data: { companyId, name: 'Shared Applicant', primaryPhone: '9876540000', primaryPhoneNormalized: '9876540000' },
    });
    applicantId = applicant.id;
  });

  afterAll(async () => {
    await systemPrisma.inquiry.deleteMany({ where: { companyId } });
    await systemPrisma.applicant.deleteMany({ where: { companyId } });
    await systemPrisma.company.delete({ where: { id: companyId } });
    await systemPrisma.$disconnect();
  });

  describe('ageing buckets', () => {
    it('buckets seeded inquiries correctly against a frozen clock', async () => {
      const fixtures = [
        { days: 3, expected: '0-7' },
        { days: 7, expected: '0-7' },
        { days: 8, expected: '8-30' },
        { days: 30, expected: '8-30' },
        { days: 31, expected: '31-90' },
        { days: 90, expected: '31-90' },
        { days: 91, expected: '90+' },
        { days: 400, expected: '90+' },
      ];

      for (const f of fixtures) {
        await systemPrisma.inquiry.create({
          data: { companyId, applicantId, status: 'OPEN' },
        });
      }
      // createdAt defaults to now() on insert; patch it to the fixture's
      // known age via raw UPDATE so the ageing-bucket math has a fixed date.
      const created = await systemPrisma.inquiry.findMany({ where: { companyId } });
      for (let i = 0; i < fixtures.length; i++) {
        await systemPrisma.$executeRaw`UPDATE inquiries SET created_at = ${daysAgo(fixtures[i].days)} WHERE id = ${created[i].id}::uuid`;
      }

      const buckets = await reportsService.ageingBuckets(companyId, {});
      const byBucket = new Map(buckets.map((b: { bucket: string; count: number }) => [b.bucket, b.count]));

      expect(byBucket.get('0-7')).toBe(2);
      expect(byBucket.get('8-30')).toBe(2);
      expect(byBucket.get('31-90')).toBe(2);
      expect(byBucket.get('90+')).toBe(2);
    });
  });

  describe('funnel reconciliation on ~200 seeded inquiries', () => {
    const TOTAL = 200;
    const statusCycle = ['OPEN', 'CONTINUED', 'DUMPED', 'SUCCESSFUL'] as const;
    let funnelCompanyId: string;
    let funnelApplicantId: string;

    beforeAll(async () => {
      // Isolated company so this block's exact-count assertions can't be
      // polluted by the ageing-bucket fixtures created above.
      const company = await systemPrisma.company.create({
        data: { name: 'Funnel Test Co', slug: `funnel-test-${Date.now()}` },
      });
      funnelCompanyId = company.id;
      const applicant = await systemPrisma.applicant.create({
        data: {
          companyId: funnelCompanyId,
          name: 'Funnel Applicant',
          primaryPhone: '9876549999',
          primaryPhoneNormalized: '9876549999',
        },
      });
      funnelApplicantId = applicant.id;

      const rows = Array.from({ length: TOTAL }, (_, i) => ({
        companyId: funnelCompanyId,
        applicantId: funnelApplicantId,
        status: statusCycle[i % statusCycle.length],
      }));
      await systemPrisma.inquiry.createMany({ data: rows });
    });

    afterAll(async () => {
      await systemPrisma.inquiry.deleteMany({ where: { companyId: funnelCompanyId } });
      await systemPrisma.applicant.deleteMany({ where: { companyId: funnelCompanyId } });
      await systemPrisma.company.delete({ where: { id: funnelCompanyId } });
    });

    it('funnel counts reconcile exactly against raw per-status counts', async () => {
      const funnel = await reportsService.funnelByStatus(funnelCompanyId, {});
      const funnelTotal = funnel.reduce((sum: number, r: { count: number }) => sum + r.count, 0);

      const rawTotal = await systemPrisma.inquiry.count({ where: { companyId: funnelCompanyId } });
      expect(funnelTotal).toBe(rawTotal);
      expect(rawTotal).toBe(TOTAL);

      for (const row of funnel) {
        const raw = await systemPrisma.inquiry.count({
          where: { companyId: funnelCompanyId, status: row.status },
        });
        expect(row.count).toBe(raw);
      }

      // Exact expected counts given the round-robin seed cycle.
      const expectedPerStatus = TOTAL / statusCycle.length;
      for (const status of statusCycle) {
        const raw = await systemPrisma.inquiry.count({ where: { companyId: funnelCompanyId, status } });
        expect(raw).toBe(expectedPerStatus);
      }
    });
  });
});
