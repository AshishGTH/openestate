/**
 * Interest accrual under concurrency. Two accrual runs for one booking (the
 * daily job and the manual "accrue" action, or two clicks) used to both read
 * "no prior accrual" and both post the same period. The per-booking advisory
 * lock in InterestService.accrueInTx serialises them.
 *
 * The interleaving is forced, not hoped for: behindTableLock holds
 * interest_accruals until both runs are waiting, so without the advisory lock
 * both reach their read of prior accruals before either has written.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Clock } from '@openestate/shared';
import {
  makeClients,
  buildServices,
  seedCompany,
  makeUnit,
  makeApplicant,
  cleanupCompany,
  type Services,
  type CompanyFixture,
} from './helpers/postsales-harness';
import { behindTableLock } from './helpers/table-lock-barrier';

const describeIf =
  process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;

const L = (rupees: number) => BigInt(rupees) * 100n;
function simpleInterest(principal: bigint, ratePercent: number, days: number): bigint {
  const num = principal * BigInt(Math.round(ratePercent * 100)) * BigInt(days);
  const den = 365n * 10_000n;
  return (num + den / 2n) / den;
}

describeIf('interest accrual under concurrency (serial)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let svc: Services;
  let ruleId: string;
  const clock: Clock = { now: () => new Date('2026-08-01T00:00:00.000Z') };

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, clock);
    fx = await seedCompany(systemPrisma);
    const rule = await systemPrisma.interestRule.create({
      data: { companyId: fx.companyId, name: '18% simple', rateType: 'SIMPLE', ratePercent: 18, frequency: 'YEARLY' },
    });
    ruleId = rule.id;
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  async function overdueBooking() {
    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: new Date('2026-01-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(10_00_000), gstRateId: fx.defaultGstRateId }],
      },
      fx.userId,
    );
    await systemPrisma.booking.update({ where: { id: booking.id }, data: { interestRuleId: ruleId } });
    await svc.plans.createCustomPlan(
      fx.companyId,
      booking.id,
      { name: 'P', isCustom: true, installments: [{ label: 'I1', dueDate: new Date('2026-07-02'), amountPaise: L(10_00_000) }] },
      fx.userId,
    );
    return booking;
  }

  it('two accrual runs at once post the period exactly once', async () => {
    const booking = await overdueBooking();
    const asOf = new Date('2026-08-01');
    const results = await behindTableLock('interest_accruals', 2, () => [
      svc.interest.accrueForBooking(fx.companyId, booking.id, asOf),
      svc.interest.accrueForBooking(fx.companyId, booking.id, asOf),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);

    expect(await systemPrisma.interestAccrual.count({ where: { bookingId: booking.id } })).toBe(1);
    const interest = await systemPrisma.ledgerEntry.aggregate({
      where: { bookingId: booking.id, entryType: 'INTEREST' },
      _sum: { signedAmountPaise: true },
    });
    expect(interest._sum.signedAmountPaise).toBe(simpleInterest(L(10_00_000), 18, 30));
  });
});
