/**
 * Receipt entry via the API: creating a receipt through ReceiptController
 * (the actual endpoint handler, fed a real zod-parsed DTO) must produce the
 * same ledger rows and the same receiptNumber format as calling
 * ReceiptService directly — proving the controller is a thin, faithful pass-
 * through rather than a second, divergent code path.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Request } from 'express';
import { createReceiptSchema, SYSTEM_CLOCK, type JwtPayload } from '@openestate/shared';
import { ReceiptController } from '../src/postsales/receipt.controller';
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
const RECEIPT_NUMBER_RE = /^RCP\/\d{4}-\d{2}\/\d{6}$/;

function fakeRequest(companyId: string, actorId: string): Request {
  return { user: { sub: actorId, companyId } as JwtPayload } as unknown as Request;
}

describeIf('Receipt entry via the API controller', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let controller: ReceiptController;
  let fx: CompanyFixture;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    controller = new ReceiptController(svc.receipts);
    fx = await seedCompany(systemPrisma);
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  async function bookedWithPlan(price: bigint) {
    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      { unitId, primaryApplicantId: applicantId, coApplicantIds: [], bookingDate: new Date('2026-06-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: price , gstRateId: fx.defaultGstRateId }] },
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

  it('matches the service-created receipt in receiptNumber format and resulting ledger row', async () => {
    const viaControllerBooking = await bookedWithPlan(L(10_00_000));
    const viaServiceBooking = await bookedWithPlan(L(10_00_000));

    // The DTO is run through the real zod schema (createReceiptSchema),
    // exactly what nestjs-zod's global pipe would do before the controller
    // method runs — so this exercises the actual validation contract too.
    const dto = createReceiptSchema.parse({
      bookingId: viaControllerBooking.booking.id,
      receiptDate: '2026-06-16',
      mode: 'NEFT',
      grossAmountPaise: L(4_00_000).toString(),
      allocations: [{ installmentId: viaControllerBooking.installment.id, amountPaise: L(4_00_000).toString() }],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viaController = await controller.create(dto as any, fakeRequest(fx.companyId, fx.userId));
    const viaService = await svc.receipts.createReceipt(
      fx.companyId,
      {
        bookingId: viaServiceBooking.booking.id,
        receiptDate: new Date('2026-06-16'),
        mode: 'NEFT',
        grossAmountPaise: L(4_00_000),
        allocations: [{ installmentId: viaServiceBooking.installment.id, amountPaise: L(4_00_000) }],
        tdsDeductedPaise: 0n,
      },
      fx.userId,
    );

    expect(viaController.receiptNumber).toMatch(RECEIPT_NUMBER_RE);
    expect(viaService.receiptNumber).toMatch(RECEIPT_NUMBER_RE);

    const ledgerViaController = await systemPrisma.ledgerEntry.findMany({
      where: { companyId: fx.companyId, bookingId: viaControllerBooking.booking.id, receiptId: viaController.id },
    });
    const ledgerViaService = await systemPrisma.ledgerEntry.findMany({
      where: { companyId: fx.companyId, bookingId: viaServiceBooking.booking.id, receiptId: viaService.id },
    });

    expect(ledgerViaController).toHaveLength(1);
    expect(ledgerViaController[0].entryType).toBe(ledgerViaService[0].entryType);
    expect(ledgerViaController[0].signedAmountPaise).toBe(ledgerViaService[0].signedAmountPaise);
    expect(ledgerViaController[0].signedAmountPaise).toBe(-L(4_00_000));

    const balanceViaController = await svc.ledger.balance(fx.companyId, viaControllerBooking.booking.id);
    expect(balanceViaController).toBe(L(6_00_000)); // 10L charge - 4L receipted
  });
});
