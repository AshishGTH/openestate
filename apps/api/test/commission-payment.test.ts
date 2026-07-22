/**
 * CommissionPaymentService: request -> approve -> pay lifecycle, TDS-194H
 * computed server-side only at pay() (required test #9), and multi-booking
 * oldest-outstanding-first allocation with proportional TDS splitting.
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
import { CommissionPaymentService } from '../src/commission/commission-payment.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const L = (rupees: number) => BigInt(rupees) * 100n;

describeIf('CommissionPaymentService: lifecycle + 194-H TDS', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let rules: BrokerCommissionRuleService;
  let commission: CommissionService;
  let payments: CommissionPaymentService;
  let fx: CompanyFixture;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    rules = new BrokerCommissionRuleService(tenantPrisma, systemPrisma);
    commission = new CommissionService(tenantPrisma, systemPrisma, rules);
    payments = new CommissionPaymentService(tenantPrisma, systemPrisma, commission);
    fx = await seedCompany(systemPrisma);
    await systemPrisma.tdsRule.create({
      data: { companyId: fx.companyId, section: '194-H', ratePercent: 5, thresholdPaise: L(15_000), effectiveFrom: new Date('2019-09-01') },
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
      { unitId, primaryApplicantId: applicantId, coApplicantIds: [], bookingDate: new Date('2026-06-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: price }] },
      fx.userId,
    );
    await systemPrisma.booking.update({ where: { id: booking.id }, data: { brokerId } });
    return booking.id;
  }

  it('request -> approve -> pay: TDS is computed ONLY at pay(), server-side, above the 194-H threshold', async () => {
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, 2);
    const bookingId = await bookedWithBroker(L(50_00_000), brokerId); // 2% = 1,00,000 accrual
    await commission.accrueForBooking(fx.companyId, bookingId, fx.userId);

    const request = await payments.request(fx.companyId, { brokerId, amountPaise: L(1_00_000) }, fx.userId);
    expect(request.status).toBe('REQUESTED');

    // No ledger entries yet — request/approve are pure sign-off.
    let ledgerCount = (await systemPrisma.commissionLedgerEntry.findMany({ where: { companyId: fx.companyId, brokerId } })).length;
    expect(ledgerCount).toBe(1); // just the original ACCRUAL

    const approved = await payments.approve(fx.companyId, request.id, fx.userId);
    expect(approved.status).toBe('APPROVED');
    ledgerCount = (await systemPrisma.commissionLedgerEntry.findMany({ where: { companyId: fx.companyId, brokerId } })).length;
    expect(ledgerCount).toBe(1); // still just the ACCRUAL — approve() posts nothing

    const paid = await payments.pay(fx.companyId, request.id, { mode: 'NEFT', paymentDate: new Date('2026-07-01') }, fx.userId);
    expect(paid.status).toBe('PAID');

    // 1,00,000 is above the 15,000 threshold -> 5% TDS = 5,000, net paid 95,000.
    const entries = await systemPrisma.commissionLedgerEntry.findMany({ where: { companyId: fx.companyId, brokerId, bookingId } });
    const tdsEntry = entries.find((e: { entryType: string }) => e.entryType === COMMISSION_ENTRY_TYPE.TDS_WITHHELD);
    const paymentEntry = entries.find((e: { entryType: string }) => e.entryType === COMMISSION_ENTRY_TYPE.PAYMENT);
    expect(tdsEntry.signedAmountPaise).toBe(-L(5_000));
    expect(paymentEntry.signedAmountPaise).toBe(-L(95_000));

    const balance = await commission.balance(fx.companyId, brokerId);
    expect(balance).toBe(0n); // 100000 - 5000 - 95000 = 0
  });

  it('sub-threshold commission payment: no TDS deducted', async () => {
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, 1);
    const bookingId = await bookedWithBroker(L(10_00_000), brokerId); // 1% = 10,000 accrual — below the 15,000 threshold
    await commission.accrueForBooking(fx.companyId, bookingId, fx.userId);

    const request = await payments.request(fx.companyId, { brokerId, amountPaise: L(10_000) }, fx.userId);
    await payments.approve(fx.companyId, request.id, fx.userId);
    await payments.pay(fx.companyId, request.id, { mode: 'NEFT', paymentDate: new Date('2026-07-01') }, fx.userId);

    const entries = await systemPrisma.commissionLedgerEntry.findMany({ where: { companyId: fx.companyId, brokerId, bookingId } });
    const tdsEntry = entries.find((e: { entryType: string }) => e.entryType === COMMISSION_ENTRY_TYPE.TDS_WITHHELD);
    expect(tdsEntry).toBeUndefined();
    expect(await commission.balance(fx.companyId, brokerId)).toBe(0n);
  });

  it('rejects a payment request exceeding the broker\'s outstanding', async () => {
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, 1);
    const bookingId = await bookedWithBroker(L(10_00_000), brokerId); // 10,000 accrual
    await commission.accrueForBooking(fx.companyId, bookingId, fx.userId);

    await expect(payments.request(fx.companyId, { brokerId, amountPaise: L(20_000) }, fx.userId)).rejects.toThrow();
  });

  it('a payment spanning two bookings allocates oldest-outstanding-first and splits TDS proportionally', async () => {
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, 2);
    const booking1 = await bookedWithBroker(L(30_00_000), brokerId); // 2% = 60,000
    await commission.accrueForBooking(fx.companyId, booking1, fx.userId);
    const booking2 = await bookedWithBroker(L(20_00_000), brokerId); // 2% = 40,000
    await commission.accrueForBooking(fx.companyId, booking2, fx.userId);
    // Total outstanding = 100,000 across both bookings.

    const request = await payments.request(fx.companyId, { brokerId, amountPaise: L(1_00_000) }, fx.userId);
    await payments.approve(fx.companyId, request.id, fx.userId);
    await payments.pay(fx.companyId, request.id, { mode: 'NEFT', paymentDate: new Date('2026-07-01') }, fx.userId);

    // 5% TDS on 1,00,000 = 5,000, split proportionally 60/40 -> 3,000 / 2,000.
    const e1 = await systemPrisma.commissionLedgerEntry.findMany({ where: { companyId: fx.companyId, bookingId: booking1, entryType: { in: ['PAYMENT', 'TDS_WITHHELD'] } } });
    const e2 = await systemPrisma.commissionLedgerEntry.findMany({ where: { companyId: fx.companyId, bookingId: booking2, entryType: { in: ['PAYMENT', 'TDS_WITHHELD'] } } });
    const sum1 = e1.reduce((s: bigint, e: { signedAmountPaise: bigint }) => s + e.signedAmountPaise, 0n);
    const sum2 = e2.reduce((s: bigint, e: { signedAmountPaise: bigint }) => s + e.signedAmountPaise, 0n);
    expect(sum1).toBe(-L(60_000)); // booking1 fully settled
    expect(sum2).toBe(-L(40_000)); // booking2 fully settled
    expect(await commission.balance(fx.companyId, brokerId)).toBe(0n);
  });
});
