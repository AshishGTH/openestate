/**
 * Masters: overlapping effective-date range rejection (h).
 *
 * Tests that GstRate and TdsRule overlap validation works correctly
 * against real Postgres. Needs DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createSystemPrismaClient } from '../src/index';
import { deleteCompaniesSafely } from './helpers/delete-company-safely';

const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const shouldRun = !!SYSTEM_URL;
const describeIf = shouldRun ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function validateGstNoOverlap(
  prisma: PrismaClient,
  companyId: string,
  from: Date,
  to: Date | null,
  excludeId?: string,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {
    companyId,
    isActive: true,
    effectiveFrom: { lte: to ?? new Date('9999-12-31') },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
  };
  if (excludeId) where.id = { not: excludeId };
  const overlap = await prisma.gstRate.findFirst({ where });
  if (overlap) {
    throw new Error(
      `Date range overlaps with existing GST rate "${overlap.description}"`,
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function validateTdsNoOverlap(
  prisma: PrismaClient,
  companyId: string,
  section: string,
  from: Date,
  to: Date | null,
  excludeId?: string,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {
    companyId,
    section,
    isActive: true,
    effectiveFrom: { lte: to ?? new Date('9999-12-31') },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
  };
  if (excludeId) where.id = { not: excludeId };
  const overlap = await prisma.tdsRule.findFirst({ where });
  if (overlap) {
    throw new Error(
      `Date range overlaps with existing TDS rule for section "${overlap.section}"`,
    );
  }
}

describeIf('Masters: overlapping effective-date validation (h)', () => {
  let prisma: PrismaClient;
  let companyId: string;

  beforeAll(async () => {
    prisma = createSystemPrismaClient(SYSTEM_URL!);
    const company = await prisma.company.create({
      data: { name: 'Overlap Test Co', slug: `overlap-test-${Date.now()}` },
    });
    companyId = company.id;
  });

  afterAll(async () => {
    await prisma.gstRate.deleteMany({ where: { companyId } });
    await prisma.tdsRule.deleteMany({ where: { companyId } });
    // Retries on syncLeadStages' own race — see delete-company-safely.ts's
    // doc comment for the exact mechanism (a single delete-then-delete
    // sequence is not enough).
    await deleteCompaniesSafely(prisma, [companyId]);
    await prisma.$disconnect();
  });

  describe('GstRate overlap', () => {
    it('allows non-overlapping GST rates', async () => {
      await prisma.gstRate.create({
        data: {
          companyId,
          rate: 5,
          description: 'GST 5%',
          effectiveFrom: new Date('2020-01-01'),
          effectiveTo: new Date('2020-12-31'),
          sortOrder: 0,
        },
      });

      await expect(
        validateGstNoOverlap(prisma, companyId, new Date('2021-01-01'), new Date('2021-12-31')),
      ).resolves.not.toThrow();
    });

    it('rejects overlapping GST rates (same company)', async () => {
      await expect(
        validateGstNoOverlap(prisma, companyId, new Date('2020-06-01'), new Date('2021-06-01')),
      ).rejects.toThrow('overlaps');
    });

    it('rejects overlap when new rate has open end and existing has open end', async () => {
      await prisma.gstRate.create({
        data: {
          companyId,
          rate: 12,
          description: 'GST 12% open-ended',
          effectiveFrom: new Date('2022-04-01'),
          effectiveTo: null,
          sortOrder: 1,
        },
      });

      await expect(
        validateGstNoOverlap(prisma, companyId, new Date('2023-01-01'), null),
      ).rejects.toThrow('overlaps');
    });
  });

  describe('TdsRule overlap', () => {
    it('allows non-overlapping TDS rules within same section', async () => {
      await prisma.tdsRule.create({
        data: {
          companyId,
          section: '194-IA',
          ratePercent: 1,
          thresholdPaise: BigInt(50_00_000_00),
          effectiveFrom: new Date('2019-09-01'),
          effectiveTo: new Date('2020-03-31'),
          sortOrder: 0,
        },
      });

      await expect(
        validateTdsNoOverlap(
          prisma, companyId, '194-IA',
          new Date('2020-04-01'), new Date('2021-03-31'),
        ),
      ).resolves.not.toThrow();
    });

    it('rejects overlapping TDS rules in the same section', async () => {
      await expect(
        validateTdsNoOverlap(
          prisma, companyId, '194-IA',
          new Date('2020-01-01'), new Date('2020-06-30'),
        ),
      ).rejects.toThrow('overlaps');
    });

    it('allows same dates in different sections (no overlap across sections)', async () => {
      await expect(
        validateTdsNoOverlap(
          prisma, companyId, '194-IB',
          new Date('2019-09-01'), new Date('2020-03-31'),
        ),
      ).resolves.not.toThrow();
    });
  });
});
