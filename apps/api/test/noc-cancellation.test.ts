/**
 * NOC gating (required test #5) and cancel+clawback transactional
 * atomicity (required test #6), both exercised through the real
 * BookingController.cancel() handler — the actual endpoint code, not a
 * service-level shortcut — since the whole point of these tests is to
 * prove the controller's outer withTenantTx wiring (BookingController.cancel(),
 * apps/api/src/postsales/booking.controller.ts) behaves correctly.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Request } from 'express';
import { SYSTEM_CLOCK, BOOKING_STATUS, CANCELLATION_TYPE, type JwtPayload } from '@openestate/shared';
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
import { BookingController } from '../src/postsales/booking.controller';
import { BrokerCommissionRuleService } from '../src/brokers/broker-commission-rule.service';
import { CommissionService } from '../src/commission/commission.service';
import { NocService } from '../src/brokers/noc.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const L = (rupees: number) => BigInt(rupees) * 100n;

function fakeRequest(companyId: string, actorId: string): Request {
  return { user: { sub: actorId, companyId } as JwtPayload } as unknown as Request;
}

describeIf('BookingController.cancel(): NOC gating + transactional atomicity', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let rules: BrokerCommissionRuleService;
  let commission: CommissionService;
  let nocs: NocService;
  let controller: BookingController;
  let fx: CompanyFixture;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    rules = new BrokerCommissionRuleService(tenantPrisma, systemPrisma);
    commission = new CommissionService(tenantPrisma, systemPrisma, rules);
    nocs = new NocService(tenantPrisma, systemPrisma);
    controller = new BookingController(
      tenantPrisma,
      svc.bookings,
      svc.plans,
      svc.extraCharges,
      svc.interest,
      svc.transfers,
      svc.cancellations,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      null as any, // BrokerService — unused by cancel(); tests call makeBroker() against systemPrisma directly
      nocs,
      commission,
    );
    fx = await seedCompany(systemPrisma);
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
    return { bookingId: booking.id, unitId };
  }

  it('BookingController.accrueCommission() delegates to CommissionService.accrueForBooking (regression: this endpoint was missing entirely until caught by manual click-through)', async () => {
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, 2);
    const { bookingId } = await bookedWithBroker(L(20_00_000), brokerId);

    const entry = await controller.accrueCommission(bookingId, fakeRequest(fx.companyId, fx.userId));
    expect(entry.signedAmountPaise).toBe(L(40_000)); // 2% of 20,00,000

    const entries = await systemPrisma.commissionLedgerEntry.findMany({ where: { companyId: fx.companyId, bookingId } });
    expect(entries).toHaveLength(1);
  });

  it('blocks cancellation when the booking has a sourcing broker and no APPROVED NOC exists', async () => {
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, 2);
    const { bookingId } = await bookedWithBroker(L(20_00_000), brokerId);

    await expect(
      controller.cancel(bookingId, { cancellationType: CANCELLATION_TYPE.CANCEL }, fakeRequest(fx.companyId, fx.userId)),
    ).rejects.toThrow(/NOC/);

    const booking = await systemPrisma.booking.findFirst({ where: { id: bookingId } });
    expect(booking.status).not.toBe(BOOKING_STATUS.CANCELLED);
  });

  it('an APPROVED NOC unblocks cancellation', async () => {
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, 2);
    const { bookingId } = await bookedWithBroker(L(20_00_000), brokerId);

    const noc = await nocs.request(fx.companyId, bookingId, {}, fx.userId);
    await nocs.approve(fx.companyId, noc.id, fx.userId);

    const result = await controller.cancel(bookingId, { cancellationType: CANCELLATION_TYPE.CANCEL }, fakeRequest(fx.companyId, fx.userId));
    expect(result.cancellation).toBeTruthy();

    const booking = await systemPrisma.booking.findFirst({ where: { id: bookingId } });
    expect(booking.status).toBe(BOOKING_STATUS.CANCELLED);
  });

  it('an inactive broker auto-approves the NOC (audited) without a manual request', async () => {
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, 2);
    const { bookingId } = await bookedWithBroker(L(20_00_000), brokerId);
    await systemPrisma.broker.update({ where: { id: brokerId }, data: { isActive: false, deactivatedAt: new Date() } });

    const result = await controller.cancel(bookingId, { cancellationType: CANCELLATION_TYPE.CANCEL }, fakeRequest(fx.companyId, fx.userId));
    expect(result.cancellation).toBeTruthy();

    const autoNoc = await systemPrisma.brokerNoc.findFirst({ where: { companyId: fx.companyId, bookingId, reason: 'broker_inactive_auto_approved' } });
    expect(autoNoc).toBeTruthy();
    expect(autoNoc.status).toBe('APPROVED');
  });

  it('rolls back the ENTIRE cancellation (unit + booking status) if the clawback step throws', async () => {
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, 2);
    const { bookingId, unitId } = await bookedWithBroker(L(20_00_000), brokerId);
    const noc = await nocs.request(fx.companyId, bookingId, {}, fx.userId);
    await nocs.approve(fx.companyId, noc.id, fx.userId);

    const brokenCommission = { handleBookingCancelled: async () => { throw new Error('simulated clawback failure'); } };
    const brokenController = new BookingController(
      tenantPrisma,
      svc.bookings,
      svc.plans,
      svc.extraCharges,
      svc.interest,
      svc.transfers,
      svc.cancellations,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      null as any,
      nocs,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      brokenCommission as any,
    );

    await expect(
      brokenController.cancel(bookingId, { cancellationType: CANCELLATION_TYPE.CANCEL }, fakeRequest(fx.companyId, fx.userId)),
    ).rejects.toThrow(/simulated clawback failure/);

    // Fresh reads (outside the failed transaction) — both the booking's
    // status transition AND the unit's release-to-AVAILABLE, both performed
    // inside CancellationService.cancel() further down the SAME outer tx,
    // must have rolled back too.
    const booking = await systemPrisma.booking.findFirst({ where: { id: bookingId } });
    expect(booking.status).toBe(BOOKING_STATUS.BOOKED);
    const unit = await systemPrisma.unit.findFirst({ where: { id: unitId } });
    expect(unit.status).toBe('BOOKED');

    // The ledger must show no cancellation entries either — same rollback.
    const cancellationEntries = await systemPrisma.ledgerEntry.findMany({
      where: { companyId: fx.companyId, bookingId, entryType: { in: ['CANCELLATION_DEDUCTION', 'CANCELLATION_SETTLEMENT'] } },
    });
    expect(cancellationEntries).toHaveLength(0);
  });
});
