/**
 * Commission accrual: the BrokerBookingCommission snapshot never changes
 * once computed (required change #1), and ON_COLLECTION_MILESTONE accrual
 * is idempotent under repeated calls, including across a receipt reversal
 * + re-post (required change #2's one-way ratchet).
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SYSTEM_CLOCK, COMMISSION_ENTRY_TYPE } from '@openestate/shared';
import {
  makeClients,
  buildServices,
  seedCompany,
  makeUnit,
  makeApplicant,
  makeBroker,
  makeFlatCommissionRule,
  cleanupCompany,
  type Services,
  type CompanyFixture,
} from './helpers/postsales-harness';
import { BrokerCommissionRuleService } from '../src/brokers/broker-commission-rule.service';
import { CommissionService } from '../src/commission/commission.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const L = (rupees: number) => BigInt(rupees) * 100n;

describeIf('Commission accrual: snapshot immutability + milestone idempotency', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let rules: BrokerCommissionRuleService;
  let commission: CommissionService;
  let fx: CompanyFixture;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    rules = new BrokerCommissionRuleService(tenantPrisma, systemPrisma);
    commission = new CommissionService(tenantPrisma, systemPrisma, rules);
    fx = await seedCompany(systemPrisma);
    await systemPrisma.companyConfig.update({
      where: { companyId: fx.companyId },
      data: { commissionAccrualTrigger: 'ON_COLLECTION_MILESTONE' },
    });
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  async function bookedWithBroker(price: bigint, brokerId: string) {
    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      { unitId, primaryApplicantId: applicantId, coApplicantIds: [], bookingDate: new Date('2026-06-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: price , gstRateId: fx.defaultGstRateId }] },
      fx.userId,
    );
    await systemPrisma.booking.update({ where: { id: booking.id }, data: { brokerId } });
    const plan = await svc.plans.createCustomPlan(
      fx.companyId,
      booking.id,
      { name: 'P', isCustom: true, installments: [{ label: 'I1', dueDate: new Date('2026-06-15'), amountPaise: price }] },
      fx.userId,
    );
    return { bookingId: booking.id, installmentId: plan.installments[0].id };
  }

  it('freezes the commission total at first accrual — a later rule edit does not affect already-in-flight bookings (required change #1)', async () => {
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    const ruleId = await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, 2, [25, 50, 100]);
    const { bookingId, installmentId } = await bookedWithBroker(L(50_00_000), brokerId);

    // First receipt crosses the 25% milestone -> creates the snapshot at 2%.
    await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId, receiptDate: new Date('2026-06-16'), mode: 'NEFT', grossAmountPaise: L(12_50_000), allocations: [{ installmentId, amountPaise: L(12_50_000) }], tdsDeductedPaise: 0n },
      fx.userId,
    );
    await commission.accrueForBooking(fx.companyId, bookingId, fx.userId);

    const snapshot = await systemPrisma.brokerBookingCommission.findFirst({ where: { companyId: fx.companyId, bookingId } });
    expect(snapshot.totalCommissionPaise).toBe(L(1_00_000)); // 2% of 50,00,000

    // Mutate the rule AFTER the first milestone crossing.
    await systemPrisma.brokerCommissionRule.update({ where: { id: ruleId }, data: { flatPercent: 10 } });

    // A second receipt on the SAME installment crosses to 50% total collected.
    await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId, receiptDate: new Date('2026-06-17'), mode: 'NEFT', grossAmountPaise: L(12_50_000), allocations: [{ installmentId, amountPaise: L(12_50_000) }], tdsDeductedPaise: 0n },
      fx.userId,
    );
    await commission.accrueForBooking(fx.companyId, bookingId, fx.userId);

    // Snapshot itself must be unchanged.
    const snapshotAfter = await systemPrisma.brokerBookingCommission.findFirst({ where: { companyId: fx.companyId, bookingId } });
    expect(snapshotAfter.totalCommissionPaise).toBe(L(1_00_000));

    // Posted accrual so far = milestones 25% + 50% shares of the FROZEN
    // 1,00,000 total (25,000 + 25,000 = 50,000) — NOT of a 10%-based
    // 5,00,000 total (which would give 125,000 + 125,000 = 250,000).
    const entries = await systemPrisma.commissionLedgerEntry.findMany({ where: { companyId: fx.companyId, bookingId, entryType: COMMISSION_ENTRY_TYPE.ACCRUAL } });
    const total = entries.reduce((s: bigint, e: { signedAmountPaise: bigint }) => s + e.signedAmountPaise, 0n);
    expect(entries).toHaveLength(2);
    expect(total).toBe(L(50_000));
  });

  it('accrues exactly once per milestone across 4 receipts, surviving a reversal + re-post (required change #2)', async () => {
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, 2, [25, 50, 100]);
    const { bookingId, installmentId } = await bookedWithBroker(L(1_00_00_000), brokerId);
    // Total commission = 2% of 1,00,00,000 = 2,00,000. Milestone shares
    // (weights [25,25,50]) = [50,000, 50,000, 1,00,000].

    async function receipt(amountPaise: bigint, date: string) {
      return svc.receipts.createReceipt(
        fx.companyId,
        { bookingId, receiptDate: new Date(date), mode: 'NEFT', grossAmountPaise: amountPaise, allocations: [{ installmentId, amountPaise }], tdsDeductedPaise: 0n },
        fx.userId,
      );
    }
    async function accruedEntries() {
      return systemPrisma.commissionLedgerEntry.findMany({ where: { companyId: fx.companyId, bookingId, entryType: COMMISSION_ENTRY_TYPE.ACCRUAL } });
    }

    const receiptA = await receipt(L(25_00_000), '2026-06-16'); // 25% -> milestone 25
    await commission.accrueForBooking(fx.companyId, bookingId, fx.userId);
    let entries = await accruedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].milestonePercent).toBe(25);

    const receiptB = await receipt(L(25_00_000), '2026-06-17'); // cumulative 50% -> milestone 50
    await commission.accrueForBooking(fx.companyId, bookingId, fx.userId);
    entries = await accruedEntries();
    expect(entries).toHaveLength(2);

    // Reverse receiptB -> collected drops back to 25%. The one-way ratchet
    // means milestone 50 stays posted; accrue() must not un-post it.
    await svc.receipts.reverseReceipt(fx.companyId, receiptB.id, 'test reversal', fx.userId);
    await commission.accrueForBooking(fx.companyId, bookingId, fx.userId);
    entries = await accruedEntries();
    expect(entries).toHaveLength(2);
    expect(entries.reduce((s: bigint, e: { signedAmountPaise: bigint }) => s + e.signedAmountPaise, 0n)).toBe(L(1_00_000));

    // Re-post an equivalent receipt -> collected back to 50%. Idempotency
    // must not double-post milestone 50 a second time.
    await receipt(L(25_00_000), '2026-06-18');
    await commission.accrueForBooking(fx.companyId, bookingId, fx.userId);
    entries = await accruedEntries();
    expect(entries).toHaveLength(2);

    // Final receipt reaches 100% -> milestone 100 posts.
    await receipt(L(50_00_000), '2026-06-19');
    await commission.accrueForBooking(fx.companyId, bookingId, fx.userId);
    entries = await accruedEntries();
    expect(entries).toHaveLength(3);
    const total = entries.reduce((s: bigint, e: { signedAmountPaise: bigint }) => s + e.signedAmountPaise, 0n);
    expect(total).toBe(L(2_00_000));
    void receiptA;
  });

  it('ON_BOOKING mode accrues the full commission once and is idempotent on repeated calls', async () => {
    await systemPrisma.companyConfig.update({ where: { companyId: fx.companyId }, data: { commissionAccrualTrigger: 'ON_BOOKING' } });
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, 3);
    const { bookingId } = await bookedWithBroker(L(20_00_000), brokerId);

    await commission.accrueForBooking(fx.companyId, bookingId, fx.userId);
    await commission.accrueForBooking(fx.companyId, bookingId, fx.userId); // repeat call — must no-op

    const entries = await systemPrisma.commissionLedgerEntry.findMany({ where: { companyId: fx.companyId, bookingId } });
    expect(entries).toHaveLength(1);
    expect(entries[0].signedAmountPaise).toBe(L(60_000)); // 3% of 20,00,000
    await systemPrisma.companyConfig.update({ where: { companyId: fx.companyId }, data: { commissionAccrualTrigger: 'ON_COLLECTION_MILESTONE' } });
  });
});
