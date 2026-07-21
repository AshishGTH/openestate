/**
 * Deterministic ledger walk-through: booking → receipts → cheque bounce, with
 * balance == Σ(ledger) asserted at every step, plus append-only enforcement.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SYSTEM_CLOCK } from '@openestate/shared';
import { runWithTenant, withTenantTx } from '@openestate/db';
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

const L = (rupees: number) => BigInt(rupees) * 100n; // rupees → paise

describeIf('Ledger walk-through (balance == Σ ledger at every step)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let fx: CompanyFixture;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    fx = await seedCompany(systemPrisma);
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  async function entryCount(bookingId: string): Promise<number> {
    return runWithTenant({ companyId: fx.companyId }, () =>
      withTenantTx(tenantPrisma, fx.companyId, (tx) =>
        tx.ledgerEntry.count({ where: { companyId: fx.companyId, bookingId } }),
      ),
    );
  }

  it('walks a booking through receipts and a cheque bounce, conserving the invariant', async () => {
    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);

    // Booking: single base line ₹30,00,000, no GST → agreed price ₹30,00,000.
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: new Date('2026-06-01'),
        costLines: [{ kind: 'BASE', label: 'Base Sale Price', baseAmountPaise: L(30_00_000) }],
      },
      fx.userId,
    );

    expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(L(30_00_000));
    const c0 = await entryCount(booking.id);

    // Custom plan: 3 × ₹10,00,000.
    const plan = await svc.plans.createCustomPlan(
      fx.companyId,
      booking.id,
      {
        name: 'Test Plan',
        isCustom: true,
        installments: [
          { label: 'I1', dueDate: new Date('2026-06-15'), amountPaise: L(10_00_000) },
          { label: 'I2', dueDate: new Date('2026-07-15'), amountPaise: L(10_00_000) },
          { label: 'I3', dueDate: new Date('2026-08-15'), amountPaise: L(10_00_000) },
        ],
      },
      fx.userId,
    );
    const [i1, i2, i3] = plan.installments;

    // R1 NEFT ₹15L → I1 full, I2 part.
    await svc.receipts.createReceipt(
      fx.companyId,
      {
        bookingId: booking.id,
        receiptDate: new Date('2026-06-16'),
        mode: 'NEFT',
        grossAmountPaise: L(15_00_000),
        allocations: [
          { installmentId: i1.id, amountPaise: L(10_00_000) },
          { installmentId: i2.id, amountPaise: L(5_00_000) },
        ],
        tdsDeductedPaise: 0n,
      },
      fx.userId,
    );
    expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(L(15_00_000));

    // R2 cheque ₹10L → I2 rest + I3 part.
    const r2 = await svc.receipts.createReceipt(
      fx.companyId,
      {
        bookingId: booking.id,
        receiptDate: new Date('2026-06-20'),
        mode: 'CHEQUE',
        grossAmountPaise: L(10_00_000),
        allocations: [
          { installmentId: i2.id, amountPaise: L(5_00_000) },
          { installmentId: i3.id, amountPaise: L(5_00_000) },
        ],
        tdsDeductedPaise: 0n,
        bankId: undefined,
        instrumentNumber: '000123',
      },
      fx.userId,
    );
    expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(L(5_00_000));

    // R2 bounces → reverse ₹10L + ₹500 bounce charge.
    await svc.receipts.recordChequeEvent(
      fx.companyId,
      r2.id,
      { status: 'BOUNCED', eventDate: new Date('2026-06-25') },
      fx.userId,
    );
    // 5,00,000 + 10,00,000 (reversal) + 500 (charge) = 15,00,500.
    expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(L(15_00_000) + L(500));

    // Installment I2/I3 reverted to unpaid/part per the reversal.
    const i2After = await systemPrisma.installment.findFirst({ where: { id: i2.id } });
    expect(i2After.allocatedPaise).toBe(L(5_00_000)); // R1's 5L remains; R2's 5L reversed
    expect(i2After.status).toBe('PART_PAID');

    // Append-only: entries only ever grew.
    expect(await entryCount(booking.id)).toBeGreaterThan(c0);
  });

  it('plan edit regenerates only unpaid installments; paid ones are immutable', async () => {
    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: new Date('2026-06-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(30_00_000) }],
      },
      fx.userId,
    );
    const plan = await svc.plans.createCustomPlan(
      fx.companyId,
      booking.id,
      {
        name: 'P',
        isCustom: true,
        installments: [
          { label: 'I1', dueDate: new Date('2026-06-15'), amountPaise: L(10_00_000) },
          { label: 'I2', dueDate: new Date('2026-07-15'), amountPaise: L(10_00_000) },
          { label: 'I3', dueDate: new Date('2026-08-15'), amountPaise: L(10_00_000) },
        ],
      },
      fx.userId,
    );
    // Pay I1 fully → it becomes frozen.
    await svc.receipts.createReceipt(
      fx.companyId,
      {
        bookingId: booking.id,
        receiptDate: new Date('2026-06-16'),
        mode: 'NEFT',
        grossAmountPaise: L(10_00_000),
        allocations: [{ installmentId: plan.installments[0].id, amountPaise: L(10_00_000) }],
        tdsDeductedPaise: 0n,
      },
      fx.userId,
    );

    // Edit: replace the remaining ₹20,00,000 with two new ₹10,00,000 installments.
    const edited = await svc.plans.editPlan(
      fx.companyId,
      booking.id,
      [
        { label: 'New A', dueDate: new Date('2026-09-15'), amountPaise: L(10_00_000) },
        { label: 'New B', dueDate: new Date('2026-10-15'), amountPaise: L(10_00_000) },
      ],
      fx.userId,
    );

    // Frozen I1 survives; the two unpaid ones are gone; two new ones added.
    const labels = edited.installments.map((i: { label: string }) => i.label).sort();
    expect(labels).toEqual(['I1', 'New A', 'New B']);
    const frozen = edited.installments.find((i: { label: string }) => i.label === 'I1');
    expect(frozen.allocatedPaise).toBe(L(10_00_000));
    // Schedule still sums to the agreed price.
    const sum = edited.installments.reduce((s: bigint, i: { amountPaise: bigint }) => s + i.amountPaise, 0n);
    expect(sum).toBe(L(30_00_000));

    // Editing such that the paid installment would be dropped is impossible:
    // a new schedule that doesn't leave room for the frozen amount is rejected.
    await expect(
      svc.plans.editPlan(
        fx.companyId,
        booking.id,
        [{ label: 'Too big', dueDate: new Date('2026-09-15'), amountPaise: L(30_00_000) }],
        fx.userId,
      ),
    ).rejects.toThrow();
  });

  it('forbids UPDATE and DELETE on ledger_entries at the database level', async () => {
    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: new Date('2026-06-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(10_00_000) }],
      },
      fx.userId,
    );

    await expect(
      runWithTenant({ companyId: fx.companyId }, () =>
        withTenantTx(tenantPrisma, fx.companyId, (tx) =>
          (tx as { $executeRawUnsafe: (q: string) => Promise<unknown> }).$executeRawUnsafe(
            `UPDATE ledger_entries SET signed_amount_paise = 0 WHERE booking_id = '${booking.id}'`,
          ),
        ),
      ),
    ).rejects.toThrow(/append-only/i);

    await expect(
      runWithTenant({ companyId: fx.companyId }, () =>
        withTenantTx(tenantPrisma, fx.companyId, (tx) =>
          (tx as { $executeRawUnsafe: (q: string) => Promise<unknown> }).$executeRawUnsafe(
            `DELETE FROM ledger_entries WHERE booking_id = '${booking.id}'`,
          ),
        ),
      ),
    ).rejects.toThrow(/append-only/i);
  });
});
