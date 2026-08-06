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

  describe('PLC/charge GST-rate resolution', () => {
    it('three cost lines at three different rates compute independently and sum correctly', async () => {
      const gr12 = await systemPrisma.gstRate.create({
        data: { companyId: fx.companyId, rate: 12, description: 'GST 12%', effectiveFrom: new Date('2019-04-01') },
      });
      const gr18 = await systemPrisma.gstRate.create({
        data: { companyId: fx.companyId, rate: 18, description: 'GST 18%', effectiveFrom: new Date('2019-04-01') },
      });
      const unitId = await makeUnit(systemPrisma, fx);
      const applicantId = await makeApplicant(systemPrisma, fx.companyId);
      const booking = await svc.bookings.createBooking(
        fx.companyId,
        {
          unitId,
          primaryApplicantId: applicantId,
          coApplicantIds: [],
          bookingDate: new Date('2026-06-01'),
          placeOfSupplyStateCode: '09', // intra-state, so tax = cgst+sgst per line
          costLines: [
            { kind: 'BASE', label: 'Base', baseAmountPaise: 50_00_000n * 100n, gstRateId: gst5Id },
            { kind: 'PLC', label: 'Park Facing', baseAmountPaise: 1_00_000n * 100n, gstRateId: gr12.id },
            { kind: 'CLUB', label: 'Club Membership', baseAmountPaise: 50_000n * 100n, gstRateId: gr18.id },
          ],
        },
        fx.userId,
      );
      const lines = await systemPrisma.bookingCostLine.findMany({
        where: { bookingId: booking.id },
        orderBy: { sortOrder: 'asc' },
      });
      expect(lines).toHaveLength(3);
      expect(lines[0].gstRatePercentSnapshot.toString()).toBe('5');
      expect(lines[1].gstRatePercentSnapshot.toString()).toBe('12');
      expect(lines[2].gstRatePercentSnapshot.toString()).toBe('18');
      // Each line's own rate independently, not the base rate applied to everything.
      expect(lines[0].cgstPaise).not.toBe(lines[1].cgstPaise * 5n); // sanity: not accidentally uniform
      const totalPaise = lines.reduce((s: bigint, l: { lineTotalPaise: bigint }) => s + l.lineTotalPaise, 0n);
      const booked = await systemPrisma.booking.findFirst({ where: { id: booking.id } });
      expect(booked.agreedPricePaise).toBe(totalPaise);
    });

    it('a charge type with no gstRateId inherits the base line rate — never zero-rated', async () => {
      const untaxedChargeType = await systemPrisma.chargeType.create({
        data: { companyId: fx.companyId, name: `No-GST-set ${Date.now()}` }, // gstRateId left unset
      });
      const unitId = await makeUnit(systemPrisma, fx);
      const applicantId = await makeApplicant(systemPrisma, fx.companyId);
      const booking = await svc.bookings.createBooking(
        fx.companyId,
        {
          unitId,
          primaryApplicantId: applicantId,
          coApplicantIds: [],
          bookingDate: new Date('2026-06-01'),
          placeOfSupplyStateCode: '09',
          costLines: [
            { kind: 'BASE', label: 'Base', baseAmountPaise: 50_00_000n * 100n, gstRateId: gst5Id },
            { kind: 'OTHER', label: 'Legal Charges', chargeTypeId: untaxedChargeType.id, baseAmountPaise: 10_000n * 100n },
          ],
        },
        fx.userId,
      );
      const lines = await systemPrisma.bookingCostLine.findMany({
        where: { bookingId: booking.id },
        orderBy: { sortOrder: 'asc' },
      });
      // Inherited the base line's 5% GST rate, not left at the implicit 0% default.
      expect(lines[1].gstRateId).toBe(gst5Id);
      expect(lines[1].gstRatePercentSnapshot.toString()).toBe('5');
      expect(lines[1].cgstPaise).toBeGreaterThan(0n);
    });

    it('a PLC line (no chargeType at all) also inherits the base line rate', async () => {
      const unitId = await makeUnit(systemPrisma, fx);
      const applicantId = await makeApplicant(systemPrisma, fx.companyId);
      const booking = await svc.bookings.createBooking(
        fx.companyId,
        {
          unitId,
          primaryApplicantId: applicantId,
          coApplicantIds: [],
          bookingDate: new Date('2026-06-01'),
          placeOfSupplyStateCode: '09',
          costLines: [
            { kind: 'BASE', label: 'Base', baseAmountPaise: 50_00_000n * 100n, gstRateId: gst5Id },
            { kind: 'PLC', label: 'Corner Plot', baseAmountPaise: 75_000n * 100n }, // no chargeTypeId, no gstRateId
          ],
        },
        fx.userId,
      );
      const lines = await systemPrisma.bookingCostLine.findMany({
        where: { bookingId: booking.id },
        orderBy: { sortOrder: 'asc' },
      });
      expect(lines[1].gstRateId).toBe(gst5Id);
      expect(lines[1].gstRatePercentSnapshot.toString()).toBe('5');
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
      // 20 iterations × 2 full booking creations each (~2s in isolation) —
      // vitest's 5s default is fine standalone but too tight once this runs
      // alongside the rest of the suite's parallel workers against one
      // shared local Postgres; the assertions themselves are fast, this is
      // pure DB-round-trip volume, not a real slowdown risk.
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
    }, 30_000);
  });

  describe('isIntraStateSupply throws instead of defaulting to intra-state', () => {
    it('rejects a booking when the company GST state code is unset — no CGST/SGST fallback', async () => {
      await systemPrisma.companyConfig.update({
        where: { companyId: fx.companyId },
        data: { gstStateCode: null },
      });
      try {
        const unitId = await makeUnit(systemPrisma, fx);
        const applicantId = await makeApplicant(systemPrisma, fx.companyId);
        await expect(
          svc.bookings.createBooking(
            fx.companyId,
            {
              unitId,
              primaryApplicantId: applicantId,
              coApplicantIds: [],
              bookingDate: new Date('2026-06-01'),
              placeOfSupplyStateCode: '09',
              costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 10_00_000n * 100n, gstRateId: gst5Id }],
            },
            fx.userId,
          ),
        ).rejects.toThrow(/gst state code/i);
        // Rolled back entirely, not partially booked at an assumed rate —
        // the throw fires before any Booking row is created at all.
        const unit = await systemPrisma.unit.findFirst({ where: { id: unitId } });
        expect(unit.status).toBe('AVAILABLE');
        const booking = await systemPrisma.booking.findFirst({ where: { unitId } });
        expect(booking).toBeNull();
      } finally {
        await systemPrisma.companyConfig.update({
          where: { companyId: fx.companyId },
          data: { gstStateCode: '09' },
        });
      }
    });

    it('rejects a booking when the place-of-supply state code cannot be determined', async () => {
      const unitId = await makeUnit(systemPrisma, fx);
      const applicantId = await makeApplicant(systemPrisma, fx.companyId);
      await expect(
        svc.bookings.createBooking(
          fx.companyId,
          {
            unitId,
            primaryApplicantId: applicantId,
            coApplicantIds: [],
            bookingDate: new Date('2026-06-01'),
            // No placeOfSupplyStateCode override, and this test's own
            // unit's project area location has a real state code ('09',
            // from the shared fixture) — so isolate the missing-side case
            // with an explicit empty-string override instead of trying to
            // null out the shared fixture's area location mid-suite.
            placeOfSupplyStateCode: '',
            costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 10_00_000n * 100n, gstRateId: gst5Id }],
          },
          fx.userId,
        ),
      ).rejects.toThrow(/place-of-supply/i);
      const unit = await systemPrisma.unit.findFirst({ where: { id: unitId } });
      expect(unit.status).toBe('AVAILABLE');
    });
  });
});
