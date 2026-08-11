/**
 * Proves the shipped data migration
 * (packages/db/prisma/migrations/20260804120000_backfill_bounced_receipt_is_reversed)
 * actually fixes a pre-fix stale row, touches nothing else, and leaves the
 * ledger untouched — the ledger was always correct; only the is_reversed
 * flag was wrong. See CLAUDE.md's REPORTS phase entry for the bug itself.
 *
 * Runs the real .sql file (not a copy) so a future edit to the migration
 * is what gets tested, not a hand-maintained duplicate.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

const L = (rupees: number) => BigInt(rupees) * 100n;

const MIGRATION_SQL = readFileSync(
  path.join(
    __dirname,
    '../../../packages/db/prisma/migrations/20260804120000_backfill_bounced_receipt_is_reversed/migration.sql',
  ),
  'utf8',
);

describeIf('Data migration: backfill is_reversed on pre-fix bounced receipts', () => {
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

  async function bookedApplicant(price: bigint) {
    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: new Date('2026-06-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: price , gstRateId: fx.defaultGstRateId }],
      },
      fx.userId,
    );
    const plan = await svc.plans.createCustomPlan(
      fx.companyId,
      booking.id,
      { name: 'P', isCustom: true, installments: [{ label: 'I1', dueDate: new Date('2026-06-15'), amountPaise: price }] },
      fx.userId,
    );
    return { booking, installment: plan.installments[0] };
  }

  it('flips is_reversed on a fabricated pre-fix stale row, leaves ledger_entries byte-for-byte identical, and ignores everything else', async () => {
    const { booking, installment } = await bookedApplicant(L(10_00_000));

    // Genuinely bounce a cheque through the real, already-fixed service —
    // this correctly sets is_reversed and reverses the ledger.
    const chequeReceipt = await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: booking.id, receiptDate: new Date('2026-06-20'), mode: 'CHEQUE', grossAmountPaise: L(6_00_000), allocations: [{ installmentId: installment.id, amountPaise: L(6_00_000) }], tdsDeductedPaise: 0n },
      fx.userId,
    );
    await svc.receipts.recordChequeEvent(fx.companyId, chequeReceipt.id, { status: 'BOUNCED', eventDate: new Date('2026-06-22') }, fx.userId);

    const correctRow = await systemPrisma.receipt.findFirst({ where: { id: chequeReceipt.id } });
    expect(correctRow.isReversed).toBe(true);
    const ledgerBefore = await systemPrisma.ledgerEntry.findMany({
      where: { receiptId: chequeReceipt.id },
      orderBy: { id: 'asc' },
    });
    expect(ledgerBefore.length).toBeGreaterThan(0);

    // Downgrade it back to exactly the pre-fix bug state (raw SQL — the
    // append-only trigger only guards ledger_entries/receipt_allocations/
    // cheque_status_events, not receipts itself, so this is a legitimate
    // direct write simulating the old code path, not a trigger bypass).
    await systemPrisma.$executeRawUnsafe(
      `UPDATE receipts SET is_reversed = false, reversal_reason = NULL WHERE id = $1::uuid`,
      chequeReceipt.id,
    );

    // A decoy: a manually-cancelled (non-cheque) receipt, already correctly
    // is_reversed = true for an unrelated reason. Must be left untouched —
    // proves the migration doesn't just flip every reversed-looking row.
    const { booking: decoyBooking, installment: decoyInstallment } = await bookedApplicant(L(5_00_000));
    const decoyReceipt = await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: decoyBooking.id, receiptDate: new Date('2026-06-10'), mode: 'NEFT', grossAmountPaise: L(2_00_000), allocations: [{ installmentId: decoyInstallment.id, amountPaise: L(2_00_000) }], tdsDeductedPaise: 0n },
      fx.userId,
    );
    await svc.receipts.reverseReceipt(fx.companyId, decoyReceipt.id, 'Wrong booking, cancelled manually', fx.userId);
    const decoyBefore = await systemPrisma.receipt.findFirst({ where: { id: decoyReceipt.id } });
    expect(decoyBefore.isReversed).toBe(true);
    expect(decoyBefore.reversalReason).toBe('Wrong booking, cancelled manually');

    // A second decoy: a live, never-bounced, never-cancelled cheque
    // receipt still sitting in RECEIVED. Must also be left untouched.
    const liveReceipt = await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: booking.id, receiptDate: new Date('2026-06-25'), mode: 'CHEQUE', grossAmountPaise: L(1_00_000), allocations: [{ installmentId: installment.id, amountPaise: L(1_00_000) }], tdsDeductedPaise: 0n },
      fx.userId,
    );

    // Run the real, shipped migration SQL — the file this test loaded, not
    // a hand-copied query.
    await systemPrisma.$executeRawUnsafe(MIGRATION_SQL);

    const fixedRow = await systemPrisma.receipt.findFirst({ where: { id: chequeReceipt.id } });
    expect(fixedRow.isReversed).toBe(true);
    expect(fixedRow.reversalReason).toBeTruthy();

    const ledgerAfter = await systemPrisma.ledgerEntry.findMany({
      where: { receiptId: chequeReceipt.id },
      orderBy: { id: 'asc' },
    });
    expect(ledgerAfter).toEqual(ledgerBefore);

    const decoyAfter = await systemPrisma.receipt.findFirst({ where: { id: decoyReceipt.id } });
    expect(decoyAfter.isReversed).toBe(true);
    expect(decoyAfter.reversalReason).toBe('Wrong booking, cancelled manually'); // unchanged, not overwritten

    const liveAfter = await systemPrisma.receipt.findFirst({ where: { id: liveReceipt.id } });
    expect(liveAfter.isReversed).toBe(false);
    expect(liveAfter.reversalReason).toBeNull();
  });
});
