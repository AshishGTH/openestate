/**
 * Shared fixture for the portal document-scope tests (HTTP and raw-RLS).
 *
 * One company, two customers (a primary and a co-applicant) on a booking that
 * broker A sourced, an unrelated customer, a second broker, and REAL stored
 * documents of every type produced by the real DocumentService (so the files
 * exist on disk and the rows carry exactly the ids the product sets):
 * RECEIPT, STATEMENT, DEMAND_LETTER, ALLOTMENT_LETTER, REMINDER_LETTER on the
 * customer's booking, plus a BROKER_STATEMENT for each broker. A receipt, an
 * installment and a document dispatch exist so every narrowed RLS table has a
 * row a customer can see.
 */
import { SYSTEM_CLOCK, GENERATED_DOCUMENT_TYPE, COMMISSION_ENTRY_TYPE } from '@openestate/shared';
import { DocumentService } from '../../src/pdf/document.service';
import { PdfService } from '../../src/pdf/pdf.service';
import { UploadService } from '../../src/inventory/upload.service';
import { NotificationService } from '../../src/notifications/notification.service';
import { ConsoleCommunicationProvider } from '../../src/queues/communication-provider';
import {
  buildServices,
  makeUnit,
  makeApplicant,
  makeBroker,
  type CompanyFixture,
} from './postsales-harness';

const L = (rupees: number) => BigInt(rupees) * 100n;

export interface DocScopeFixture {
  applicantId: string; // primary customer
  coApplicantId: string;
  unrelatedApplicantId: string;
  brokerAId: string; // sourced the booking
  brokerBId: string;
  bookingId: string;
  otherBookingId: string; // the unrelated customer's, sourced by broker B
  installmentId: string;
  receiptId: string;
  docs: {
    receipt: string;
    statement: string;
    demand: string;
    allotment: string;
    reminder: string;
    brokerAStatement: string;
    brokerBStatement: string;
    otherCustomerStatement: string;
  };
  /** Types the customer portal lists / allows, and the ones it hides. */
  customerVisible: string[];
  customerHidden: string[];
}

export async function buildDocScopeFixture(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tenantPrisma: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  systemPrisma: any,
  fx: CompanyFixture,
): Promise<DocScopeFixture> {
  const svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
  const documents = new DocumentService(
    tenantPrisma,
    systemPrisma,
    new PdfService(),
    new UploadService(),
    svc.ledger,
    new NotificationService(systemPrisma, new ConsoleCommunicationProvider()),
  );

  const applicantId = await makeApplicant(systemPrisma, fx.companyId);
  const coApplicantId = await makeApplicant(systemPrisma, fx.companyId);
  const unrelatedApplicantId = await makeApplicant(systemPrisma, fx.companyId);
  const brokerAId = await makeBroker(systemPrisma, fx.companyId);
  const brokerBId = await makeBroker(systemPrisma, fx.companyId);

  async function bookWithPlan(primary: string, coApplicantIds: string[], brokerId: string) {
    const unitId = await makeUnit(systemPrisma, fx);
    const price = L(30_00_000);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId,
        primaryApplicantId: primary,
        coApplicantIds,
        bookingDate: new Date('2026-06-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: price, gstRateId: fx.defaultGstRateId }],
      },
      fx.userId,
    );
    await systemPrisma.booking.update({ where: { id: booking.id }, data: { brokerId } });
    const plan = await svc.plans.createCustomPlan(
      fx.companyId,
      booking.id,
      {
        name: 'P',
        isCustom: true,
        installments: [{ label: 'I1', dueDate: new Date('2026-06-15'), amountPaise: booking.agreedPricePaise }],
      },
      fx.userId,
    );
    return { booking, installment: plan.installments[0] };
  }

  const main = await bookWithPlan(applicantId, [coApplicantId], brokerAId);
  const other = await bookWithPlan(unrelatedApplicantId, [], brokerBId);

  const receipt = await svc.receipts.createReceipt(
    fx.companyId,
    {
      bookingId: main.booking.id,
      receiptDate: new Date('2026-06-16'),
      mode: 'NEFT',
      grossAmountPaise: L(5_00_000),
      allocations: [{ installmentId: main.installment.id, amountPaise: L(5_00_000) }],
      tdsDeductedPaise: 0n,
    },
    fx.userId,
  );

  for (const [brokerId, bookingId] of [
    [brokerAId, main.booking.id],
    [brokerBId, other.booking.id],
  ] as const) {
    await systemPrisma.commissionLedgerEntry.create({
      data: {
        companyId: fx.companyId,
        brokerId,
        bookingId,
        entryType: COMMISSION_ENTRY_TYPE.ACCRUAL,
        signedAmountPaise: L(50_000),
        effectiveDate: new Date('2026-06-15'),
      },
    });
  }

  const template = await systemPrisma.letterTemplate.create({
    data: {
      companyId: fx.companyId,
      name: `Doc scope letter ${Date.now()}`,
      subject: 'Letter for {{bookingNumber}}',
      body: 'Dear {{applicantName}}, regarding your booking.',
      entityType: 'BOOKING',
    },
  });

  const receiptDoc = await documents.generateReceiptPdf(fx.companyId, receipt.id, fx.userId);
  const statement = await documents.generateStatementPdf(fx.companyId, main.booking.id, fx.userId);
  const demand = await documents.generateLetterPdf(
    fx.companyId, GENERATED_DOCUMENT_TYPE.DEMAND_LETTER, main.booking.id, template.id, fx.userId, main.installment.id,
  );
  const allotment = await documents.generateLetterPdf(
    fx.companyId, GENERATED_DOCUMENT_TYPE.ALLOTMENT_LETTER, main.booking.id, template.id, fx.userId,
  );
  const reminder = await documents.generateLetterPdf(
    fx.companyId, GENERATED_DOCUMENT_TYPE.REMINDER_LETTER, main.booking.id, template.id, fx.userId, main.installment.id,
  );
  const brokerAStatement = await documents.generateBrokerStatementPdf(fx.companyId, brokerAId, fx.userId);
  const brokerBStatement = await documents.generateBrokerStatementPdf(fx.companyId, brokerBId, fx.userId);
  const otherCustomerStatement = await documents.generateStatementPdf(fx.companyId, other.booking.id, fx.userId);

  // A dispatch row on the customer's booking so document_dispatches has
  // something a customer can see and a broker must not.
  await systemPrisma.documentDispatch.create({
    data: {
      companyId: fx.companyId,
      generatedDocumentId: statement.id,
      bookingId: main.booking.id,
      applicantId,
      recipientAddress: 'uiaudit-doc-scope@example.invalid',
      channel: 'EMAIL',
      templateSnapshot: 'snapshot',
    },
  });

  return {
    applicantId,
    coApplicantId,
    unrelatedApplicantId,
    brokerAId,
    brokerBId,
    bookingId: main.booking.id,
    otherBookingId: other.booking.id,
    installmentId: main.installment.id,
    receiptId: receipt.id,
    docs: {
      receipt: receiptDoc.id,
      statement: statement.id,
      demand: demand.id,
      allotment: allotment.id,
      reminder: reminder.id,
      brokerAStatement: brokerAStatement.id,
      brokerBStatement: brokerBStatement.id,
      otherCustomerStatement: otherCustomerStatement.id,
    },
    customerVisible: ['receipt', 'statement', 'demand'],
    customerHidden: ['allotment', 'reminder'],
  };
}
