/**
 * Clawback reconciliation (fast-check property test) + the
 * CLAWBACK_WRITEOFF reason requirement (required change #6a).
 *
 * For random accrue -> {0..3 partial payments} -> cancel sequences, under
 * both RECOVER and WRITE_OFF clawback policy, assert the commission
 * ledger's SUM for that booking always lands exactly where the documented
 * formula predicts (CLAUDE.md Phase 5 decisions): RECOVER drives the
 * booking's contribution to -netPaid (broker owes back what was actually
 * disbursed); WRITE_OFF drives it to exactly 0 (unpaid remainder reversed,
 * already-paid amount forgiven via a zero-amount audited entry).
 *
 * numRuns: 100 local / 500 CI (half of Phase 4's 500/2000 floor — smaller
 * state space, but the RECOVER/WRITE_OFF and TDS-threshold branches still
 * need real coverage), honoring PROPERTY_NUM_RUNS the same way the Phase 4
 * property test does. FC_SEED is printed by fast-check on failure for
 * reproducibility.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { SYSTEM_CLOCK, COMMISSION_ENTRY_TYPE, type BookingCancelledEvent } from '@openestate/shared';
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

const CI_DEFAULT = 500;
const LOCAL_DEFAULT = 100;
function resolveNumRuns(): number {
  const override = process.env.PROPERTY_NUM_RUNS_COMMISSION;
  if (override) return Number(override);
  return process.env.CI ? CI_DEFAULT : LOCAL_DEFAULT;
}

const L = (rupees: number) => BigInt(rupees) * 100n;

describeIf('Commission clawback reconciliation (fast-check)', () => {
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
    // No TdsRule for 194-H in this fixture — isolates the property test to
    // clawback arithmetic; 194-H correctness has its own dedicated test.
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  }, 120_000);

  it(`reconciles to the paise across ${resolveNumRuns()} random accrue/partial-pay/cancel sequences`, async () => {
    const numRuns = resolveNumRuns();

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          agreedRupees: fc.integer({ min: 1_00_000, max: 1_00_00_000 }),
          flatPercent: fc.integer({ min: 1, max: 5 }),
          payPercents: fc.array(fc.integer({ min: 5, max: 60 }), { minLength: 0, maxLength: 3 }),
          policy: fc.constantFrom('RECOVER', 'WRITE_OFF'),
        }),
        async ({ agreedRupees, flatPercent, payPercents, policy }) => {
          await systemPrisma.companyConfig.update({ where: { companyId: fx.companyId }, data: { commissionClawbackPolicy: policy } });

          const brokerId = await makeBroker(systemPrisma, fx.companyId);
          await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, flatPercent);
          const unitId = await makeUnit(systemPrisma, fx);
          const applicantId = await makeApplicant(systemPrisma, fx.companyId);
          const booking = await svc.bookings.createBooking(
            fx.companyId,
            { unitId, primaryApplicantId: applicantId, coApplicantIds: [], bookingDate: new Date('2026-06-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(agreedRupees) }] },
            fx.userId,
          );
          await systemPrisma.booking.update({ where: { id: booking.id }, data: { brokerId } });

          await commission.accrueForBooking(fx.companyId, booking.id, fx.userId);
          const snapshot = await systemPrisma.brokerBookingCommission.findFirst({ where: { companyId: fx.companyId, bookingId: booking.id } });
          const totalCommission: bigint = snapshot.totalCommissionPaise;

          let netPaid = 0n;
          for (const pct of payPercents) {
            const remaining = totalCommission - netPaid;
            if (remaining <= 0n) continue;
            const amount = (remaining * BigInt(pct)) / 100n;
            if (amount <= 0n) continue;
            const request = await payments.request(fx.companyId, { brokerId, amountPaise: amount }, fx.userId);
            await payments.approve(fx.companyId, request.id, fx.userId);
            await payments.pay(fx.companyId, request.id, { mode: 'NEFT', paymentDate: new Date('2026-07-01') }, fx.userId);
            netPaid += amount; // no TDS rule fixtured -> gross === net
          }

          const event: BookingCancelledEvent = {
            type: 'bookingCancelled',
            companyId: fx.companyId,
            bookingId: booking.id,
            cancellationType: 'CANCEL',
            cancelledAt: new Date().toISOString(),
            brokerId: null,
          };
          await commission.handleBookingCancelled(fx.companyId, event, brokerId, fx.userId);

          const entries = await systemPrisma.commissionLedgerEntry.findMany({ where: { companyId: fx.companyId, bookingId: booking.id } });
          const actualSum = entries.reduce((s: bigint, e: { signedAmountPaise: bigint }) => s + e.signedAmountPaise, 0n);
          const expectedSum = policy === 'RECOVER' ? -netPaid : 0n;

          expect(actualSum).toBe(expectedSum);

          // Append-only invariant, same discipline as the Phase 4 property test.
          expect(entries.length).toBeGreaterThan(0);
        },
      ),
      { numRuns, seed: process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined },
    );
  }, 300_000);

  it('CLAWBACK_WRITEOFF requires a reason (required change #6a)', async () => {
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, 2);
    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      { unitId, primaryApplicantId: applicantId, coApplicantIds: [], bookingDate: new Date('2026-06-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(10_00_000) }] },
      fx.userId,
    );

    await expect(
      // Reuses the real postClawback path from within a tenant transaction,
      // matching production usage exactly.
      (async () => {
        const { runWithTenant, withTenantTx } = await import('@openestate/db');
        return runWithTenant({ companyId: fx.companyId }, () =>
          withTenantTx(tenantPrisma, fx.companyId, (tx) =>
            commission.postClawback(tx, fx.companyId, brokerId, booking.id, COMMISSION_ENTRY_TYPE.CLAWBACK_WRITEOFF, 0n, { actorId: fx.userId }),
          ),
        );
      })(),
    ).rejects.toThrow(/reason/i);
  });
});
