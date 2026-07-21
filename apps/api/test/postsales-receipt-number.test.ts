/**
 * Gap-free receipt-number allocator under concurrency.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runWithTenant, withTenantTx } from '@openestate/db';
import { NumberSequenceService } from '../src/postsales/number-sequence.service';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

describeIf('Receipt-number allocator (gap-free, concurrent)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let numbers: NumberSequenceService;
  let fxA: CompanyFixture;
  let fxB: CompanyFixture;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    numbers = new NumberSequenceService();
    fxA = await seedCompany(systemPrisma);
    fxB = await seedCompany(systemPrisma);
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fxA.companyId);
    await cleanupCompany(systemPrisma, fxB.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  function allocate(companyId: string, fy: string): Promise<number> {
    return runWithTenant({ companyId }, () =>
      withTenantTx(tenantPrisma, companyId, (tx) => numbers.allocate(tx, companyId, 'RECEIPT', fy)),
    );
  }

  it('50 concurrent allocations yield exactly {1..50}, no gaps or duplicates', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => allocate(fxA.companyId, '2026-27')));
    const sorted = [...results].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(new Set(results).size).toBe(50);
  });

  it('a second company is an independent sequence', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => allocate(fxB.companyId, '2026-27')));
    expect([...results].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('a different financial year is an independent sequence', async () => {
    const n = await allocate(fxA.companyId, '2027-28');
    expect(n).toBe(1); // fresh FY starts at 1 even though 2026-27 is at 50
  });

  it('a rolled-back transaction releases its number (gap-free)', async () => {
    // Company B's 2026-27 is at 20. A failed allocation must not consume 21.
    await expect(
      runWithTenant({ companyId: fxB.companyId }, () =>
        withTenantTx(tenantPrisma, fxB.companyId, async (tx) => {
          await numbers.allocate(tx, fxB.companyId, 'RECEIPT', '2026-27');
          throw new Error('force rollback');
        }),
      ),
    ).rejects.toThrow('force rollback');

    const next = await allocate(fxB.companyId, '2026-27');
    expect(next).toBe(21); // 21 was released by the rollback and reused
  });
});
