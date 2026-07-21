/**
 * (1) Booking-lifecycle unit statuses are system-only; the manual transition
 *     path can no longer reach them.
 * (2) GST split matrix — intra-state (CGST=SGST), inter-state (IGST), and the
 *     |IGST − (CGST+SGST)| ≤ 1 paise per line disclosure — at the booking level.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SYSTEM_CLOCK } from '@openestate/shared';
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

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

describeIf('State machine (system-only) + GST split', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let fx: CompanyFixture; // company GST state 09
  let gst5Id: string;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    fx = await seedCompany(systemPrisma, { gstStateCode: '09' });
    const gr = await systemPrisma.gstRate.create({
      data: { companyId: fx.companyId, rate: 5, description: 'GST 5%', effectiveFrom: new Date('2019-04-01') },
    });
    gst5Id = gr.id;
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  describe('system-only transitions', () => {
    it('rejects a MANUAL transition to BOOKED, allows the booking service (system)', async () => {
      const unitId = await makeUnit(systemPrisma, fx);
      // Manual (actorType 'user') → BOOKED must be rejected.
      await expect(
        svc.stateMachine.transition(fx.companyId, unitId, 'BOOKED', 'user', fx.userId, undefined),
      ).rejects.toThrow(/system-only/i);
      // Manual HELD is allowed.
      await svc.stateMachine.transition(fx.companyId, unitId, 'HELD', 'user', fx.userId, undefined);
      const held = await systemPrisma.unit.findFirst({ where: { id: unitId } });
      expect(held.status).toBe('HELD');

      // The booking service (system actor) can book it.
      const applicantId = await makeApplicant(systemPrisma, fx.companyId);
      await svc.bookings.createBooking(
        fx.companyId,
        { unitId, primaryApplicantId: applicantId, coApplicantIds: [], bookingDate: new Date('2026-06-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 10_00_000n * 100n }] },
        fx.userId,
      );
      const booked = await systemPrisma.unit.findFirst({ where: { id: unitId } });
      expect(booked.status).toBe('BOOKED');
    });

    it('rejects manual ALLOTTED and REGISTERED too', async () => {
      const unitId = await makeUnit(systemPrisma, fx);
      await expect(
        svc.stateMachine.transition(fx.companyId, unitId, 'ALLOTTED', 'user', fx.userId, undefined),
      ).rejects.toThrow(/system-only/i);
      await expect(
        svc.stateMachine.transition(fx.companyId, unitId, 'REGISTERED', 'user', fx.userId, undefined),
      ).rejects.toThrow(/system-only/i);
    });
  });

  describe('GST split', () => {
    async function bookAndReadLine(placeStateCode: string) {
      const unitId = await makeUnit(systemPrisma, fx);
      const applicantId = await makeApplicant(systemPrisma, fx.companyId);
      const booking = await svc.bookings.createBooking(
        fx.companyId,
        {
          unitId,
          primaryApplicantId: applicantId,
          coApplicantIds: [],
          bookingDate: new Date('2026-06-01'),
          placeOfSupplyStateCode: placeStateCode,
          costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 12_34_567n * 100n, gstRateId: gst5Id }],
        },
        fx.userId,
      );
      return systemPrisma.bookingCostLine.findFirst({ where: { bookingId: booking.id } });
    }

    it('intra-state (company 09, place 09) → CGST = SGST, IGST = 0', async () => {
      const line = await bookAndReadLine('09');
      expect(line.cgstPaise).toBe(line.sgstPaise);
      expect(line.cgstPaise).toBeGreaterThan(0n);
      expect(line.igstPaise).toBe(0n);
    });

    it('inter-state (company 09, place 27) → IGST only', async () => {
      const line = await bookAndReadLine('27');
      expect(line.igstPaise).toBeGreaterThan(0n);
      expect(line.cgstPaise).toBe(0n);
      expect(line.sgstPaise).toBe(0n);
    });

    it('|IGST − (CGST+SGST)| ≤ 1 paise across a base/rate matrix', async () => {
      const bases = [1n, 3n, 12_34_567n, 99_99_999n, 100_00_001n];
      const rates = [1, 5, 12, 18]; // percent
      for (const rupees of bases) {
        for (const pct of rates) {
          const gr = await systemPrisma.gstRate.create({
            data: { companyId: fx.companyId, rate: pct, description: `r${pct}-${rupees}`, effectiveFrom: new Date('2019-04-01') },
          });
          const unitId = await makeUnit(systemPrisma, fx);
          const applicantId = await makeApplicant(systemPrisma, fx.companyId);
          const intra = await svc.bookings.createBooking(
            fx.companyId,
            { unitId, primaryApplicantId: applicantId, coApplicantIds: [], bookingDate: new Date('2026-06-01'), placeOfSupplyStateCode: '09', costLines: [{ kind: 'BASE', label: 'B', baseAmountPaise: rupees * 100n, gstRateId: gr.id }] },
            fx.userId,
          );
          const unitId2 = await makeUnit(systemPrisma, fx);
          const applicantId2 = await makeApplicant(systemPrisma, fx.companyId);
          const inter = await svc.bookings.createBooking(
            fx.companyId,
            { unitId: unitId2, primaryApplicantId: applicantId2, coApplicantIds: [], bookingDate: new Date('2026-06-01'), placeOfSupplyStateCode: '27', costLines: [{ kind: 'BASE', label: 'B', baseAmountPaise: rupees * 100n, gstRateId: gr.id }] },
            fx.userId,
          );
          const li = await systemPrisma.bookingCostLine.findFirst({ where: { bookingId: intra.id } });
          const le = await systemPrisma.bookingCostLine.findFirst({ where: { bookingId: inter.id } });
          const diff = le.igstPaise - (li.cgstPaise + li.sgstPaise);
          const abs = diff < 0n ? -diff : diff;
          expect(abs <= 1n).toBe(true);
        }
      }
    });
  });
});
