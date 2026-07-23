import * as fs from 'node:fs';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import {
  GENERATED_DOCUMENT_TYPE,
  formatInr,
  resolveMergeFields,
  type GeneratedDocumentTypeValue,
  type MergeContext,
} from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { UploadService } from '../inventory/upload.service';
import { LedgerService } from '../postsales/ledger.service';
import { PdfService } from './pdf.service';
import {
  buildReceiptDocDefinition,
  buildStatementDocDefinition,
  buildBrokerStatementDocDefinition,
  buildLetterDocDefinition,
  type ReceiptPdfContext,
  type StatementPdfContext,
  type BrokerStatementPdfContext,
} from './document-templates';

@Injectable()
export class DocumentService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly pdfService: PdfService,
    private readonly uploadService: UploadService,
    private readonly ledger: LedgerService,
  ) {}

  // ── RECEIPT ────────────────────────────────────────────────

  /** Idempotent: an already-generated (non-duplicate) receipt PDF is never re-rendered. */
  async generateReceiptPdf(companyId: string, receiptId: string, actorId: string | null) {
    const existing = await this.systemPrisma.generatedDocument.findFirst({
      where: { companyId, receiptId, documentType: GENERATED_DOCUMENT_TYPE.RECEIPT, isDuplicate: false },
    });
    if (existing) return existing;

    const ctx = await this.buildReceiptContext(companyId, receiptId, false);
    const docDefinition = buildReceiptDocDefinition(ctx);
    const buffer = await this.pdfService.render(docDefinition);

    return this.store(companyId, buffer, {
      documentType: GENERATED_DOCUMENT_TYPE.RECEIPT,
      bookingId: ctx.__bookingId,
      applicantId: ctx.__applicantId,
      receiptId,
      originalName: `${ctx.receiptNumber}.pdf`,
      createdById: actorId,
    });
  }

  /** A reprint is always a NEW, separately-stored, watermarked artifact. */
  async reprintReceiptPdf(companyId: string, receiptId: string, actorId: string | null) {
    const original =
      (await this.systemPrisma.generatedDocument.findFirst({
        where: { companyId, receiptId, documentType: GENERATED_DOCUMENT_TYPE.RECEIPT, isDuplicate: false },
      })) ?? (await this.generateReceiptPdf(companyId, receiptId, actorId));

    const ctx = await this.buildReceiptContext(companyId, receiptId, true);
    const docDefinition = buildReceiptDocDefinition(ctx);
    const buffer = await this.pdfService.render(docDefinition);

    const stored = await this.store(companyId, buffer, {
      documentType: GENERATED_DOCUMENT_TYPE.RECEIPT,
      bookingId: ctx.__bookingId,
      applicantId: ctx.__applicantId,
      receiptId,
      originalName: `${ctx.receiptNumber}-DUPLICATE.pdf`,
      isDuplicate: true,
      sourceDocumentId: original.id,
      createdById: actorId,
    });

    // Keep Receipt.reprintCount in sync (existing Phase 4 service, unmodified).
    await runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.receipt.update({ where: { id: receiptId }, data: { reprintCount: { increment: 1 } } }),
      ),
    );

    return stored;
  }

  private async buildReceiptContext(
    companyId: string,
    receiptId: string,
    isDuplicate: boolean,
  ): Promise<ReceiptPdfContext & { __bookingId: string; __applicantId: string }> {
    const receipt = await this.systemPrisma.receipt.findFirst({
      where: { id: receiptId, companyId },
      include: {
        booking: { include: { primaryApplicant: true, company: true } },
        allocations: { include: { installment: true } },
      },
    });
    if (!receipt) throw new NotFoundException('Receipt not found');

    return {
      __bookingId: receipt.bookingId,
      __applicantId: receipt.booking.primaryApplicantId,
      receiptNumber: receipt.receiptNumber,
      receiptDate: receipt.receiptDate.toISOString().slice(0, 10),
      bookingNumber: receipt.booking.bookingNumber,
      applicantName: receipt.booking.primaryApplicant.name,
      mode: receipt.mode,
      instrumentNumber: receipt.instrumentNumber ?? undefined,
      allocations: receipt.allocations.map((a: { installment: { label: string }; amountPaise: bigint }) => ({
        label: a.installment.label,
        amountFormatted: formatInr(a.amountPaise),
      })),
      grossAmountFormatted: formatInr(receipt.grossAmountPaise),
      companyName: receipt.booking.company.name,
      companyAddress: '',
      isDuplicate,
    };
  }

  // ── STATEMENT ──────────────────────────────────────────────

  /** Always a fresh snapshot (the ledger is live) — never reuses an old statement. */
  async generateStatementPdf(companyId: string, bookingId: string, actorId: string | null) {
    const booking = await this.systemPrisma.booking.findFirst({
      where: { id: bookingId, companyId },
      include: {
        primaryApplicant: true,
        company: true,
        unit: { include: { floor: { include: { tower: { include: { project: true } } } } } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    const entries = await this.systemPrisma.ledgerEntry.findMany({
      where: { companyId, bookingId },
      orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }],
    });

    let running = 0n;
    const rows = entries.map((e: { effectiveDate: Date; entryType: string; reason: string | null; signedAmountPaise: bigint }) => {
      running += e.signedAmountPaise;
      const debit = e.signedAmountPaise > 0n ? e.signedAmountPaise : 0n;
      const credit = e.signedAmountPaise < 0n ? -e.signedAmountPaise : 0n;
      return {
        date: e.effectiveDate.toISOString().slice(0, 10),
        type: e.entryType,
        reason: e.reason ?? '',
        debitFormatted: debit > 0n ? formatInr(debit) : '',
        creditFormatted: credit > 0n ? formatInr(credit) : '',
        balanceFormatted: formatInr(running),
      };
    });

    const ctx: StatementPdfContext = {
      bookingNumber: booking.bookingNumber,
      applicantName: booking.primaryApplicant.name,
      projectName: booking.unit.floor.tower.project.name,
      unitNumber: booking.unit.number,
      statementDate: new Date().toISOString().slice(0, 10),
      entries: rows,
      openingBalanceFormatted: formatInr(0n),
      closingBalanceFormatted: formatInr(running),
      companyName: booking.company.name,
      companyAddress: '',
    };

    const buffer = await this.pdfService.render(buildStatementDocDefinition(ctx));
    return this.store(companyId, buffer, {
      documentType: GENERATED_DOCUMENT_TYPE.STATEMENT,
      bookingId,
      applicantId: booking.primaryApplicantId,
      originalName: `statement-${booking.bookingNumber}-${ctx.statementDate}.pdf`,
      createdById: actorId,
    });
  }

  // ── BROKER STATEMENT (Phase 5 commit 3) ────────────────────

  /** Always a fresh snapshot (the commission ledger is live), same discipline as generateStatementPdf. */
  async generateBrokerStatementPdf(companyId: string, brokerId: string, actorId: string | null) {
    const broker = await this.systemPrisma.broker.findFirst({ where: { id: brokerId, companyId } });
    if (!broker) throw new NotFoundException('Broker not found');

    const entries = await this.systemPrisma.commissionLedgerEntry.findMany({
      where: { companyId, brokerId },
      orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }],
    });
    const bookingIds = [...new Set(entries.map((e: { bookingId: string }) => e.bookingId))];
    const bookings = await this.systemPrisma.booking.findMany({ where: { companyId, id: { in: bookingIds } }, select: { id: true, bookingNumber: true } });
    const bookingNumbers = new Map(bookings.map((b: { id: string; bookingNumber: string }) => [b.id, b.bookingNumber]));

    let running = 0n;
    const rows = entries.map(
      (e: { effectiveDate: Date; bookingId: string; entryType: string; reason: string | null; signedAmountPaise: bigint }) => {
        running += e.signedAmountPaise;
        const debit = e.signedAmountPaise > 0n ? e.signedAmountPaise : 0n;
        const credit = e.signedAmountPaise < 0n ? -e.signedAmountPaise : 0n;
        return {
          date: e.effectiveDate.toISOString().slice(0, 10),
          bookingNumber: (bookingNumbers.get(e.bookingId) as string) ?? e.bookingId,
          type: e.entryType,
          reason: e.reason ?? '',
          debitFormatted: debit > 0n ? formatInr(debit) : '',
          creditFormatted: credit > 0n ? formatInr(credit) : '',
          balanceFormatted: formatInr(running),
        };
      },
    );

    const ctx: BrokerStatementPdfContext = {
      brokerName: broker.name,
      brokerPhone: broker.phone,
      reraAgentNo: broker.reraAgentNo ?? undefined,
      statementDate: new Date().toISOString().slice(0, 10),
      entries: rows,
      closingBalanceFormatted: formatInr(running),
      companyName: (await this.systemPrisma.company.findFirst({ where: { id: companyId } }))?.name ?? '',
      companyAddress: '',
    };

    const buffer = await this.pdfService.render(buildBrokerStatementDocDefinition(ctx));
    return this.store(companyId, buffer, {
      documentType: GENERATED_DOCUMENT_TYPE.BROKER_STATEMENT,
      brokerId,
      originalName: `broker-statement-${broker.name.replace(/\s+/g, '-')}-${ctx.statementDate}.pdf`,
      createdById: actorId,
    });
  }

  async listForBroker(companyId: string, brokerId: string) {
    return this.systemPrisma.generatedDocument.findMany({
      where: { companyId, brokerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Merge-field-driven letters ─────────────────────────────

  async generateLetterPdf(
    companyId: string,
    documentType: Exclude<GeneratedDocumentTypeValue, 'RECEIPT' | 'STATEMENT'>,
    bookingId: string,
    templateId: string,
    actorId: string | null,
    installmentId?: string,
  ) {
    const booking = await this.systemPrisma.booking.findFirst({
      where: { id: bookingId, companyId },
      include: {
        primaryApplicant: true,
        company: true,
        unit: { include: { floor: { include: { tower: { include: { project: true } } } } } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    const template = await this.systemPrisma.letterTemplate.findFirst({ where: { id: templateId, companyId } });
    if (!template) throw new NotFoundException('Letter template not found');

    const context = await this.buildLetterContext(companyId, documentType, booking, installmentId);
    const subject = resolveMergeFields(template.subject, documentType, context);
    const body = resolveMergeFields(template.body, documentType, context);

    const buffer = await this.pdfService.render(
      buildLetterDocDefinition({ subject, body, companyName: booking.company.name, companyAddress: '' }),
    );

    return this.store(companyId, buffer, {
      documentType,
      bookingId,
      applicantId: booking.primaryApplicantId,
      templateId,
      originalName: `${documentType.toLowerCase()}-${booking.bookingNumber}.pdf`,
      createdById: actorId,
    });
  }

  private async buildLetterContext(
    companyId: string,
    documentType: GeneratedDocumentTypeValue,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    booking: any,
    installmentId?: string,
  ): Promise<MergeContext<GeneratedDocumentTypeValue>> {
    const base = {
      applicantName: booking.primaryApplicant.name,
      bookingNumber: booking.bookingNumber,
      projectName: booking.unit.floor.tower.project.name,
      unitNumber: booking.unit.number,
      towerName: booking.unit.floor.tower.name,
      floorLabel: booking.unit.floor.name,
      agreedPriceFormatted: formatInr(booking.agreedPricePaise),
      allotmentDate: booking.allotmentDate ? booking.allotmentDate.toISOString().slice(0, 10) : '',
      companyName: booking.company.name,
      companyAddress: '',
    };

    if (documentType === GENERATED_DOCUMENT_TYPE.DEMAND_LETTER || documentType === GENERATED_DOCUMENT_TYPE.REMINDER_LETTER) {
      if (!installmentId) throw new BadRequestException(`${documentType} requires installmentId`);
      const installment = await this.systemPrisma.installment.findFirst({
        where: { id: installmentId, companyId, bookingId: booking.id },
      });
      if (!installment) throw new NotFoundException('Installment not found');
      const dueAmountPaise = installment.amountPaise - installment.allocatedPaise;
      const overdueDays = Math.max(
        0,
        Math.floor((Date.now() - installment.dueDate.getTime()) / 86_400_000),
      );
      return {
        ...base,
        installmentLabel: installment.label,
        dueDate: installment.dueDate.toISOString().slice(0, 10),
        dueAmountFormatted: formatInr(dueAmountPaise),
        overdueDays: String(overdueDays),
      } as unknown as MergeContext<GeneratedDocumentTypeValue>;
    }

    return base as unknown as MergeContext<GeneratedDocumentTypeValue>;
  }

  // ── Read / list ────────────────────────────────────────────

  async getDocumentBytes(companyId: string, id: string): Promise<{ buffer: Buffer; mimeType: string; originalName: string }> {
    const doc = await this.systemPrisma.generatedDocument.findFirst({ where: { id, companyId } });
    if (!doc) throw new NotFoundException('Document not found');
    const filePath = this.uploadService.pathFor('document', doc.storedName);
    const buffer = await fs.promises.readFile(filePath);
    return { buffer, mimeType: doc.mimeType, originalName: doc.originalName };
  }

  /**
   * Portal counterpart to getDocumentBytes(). The lookup goes through the
   * TENANT client under withTenantTx instead of the RLS-bypassing system
   * client — generated_documents_portal_scope (Phase 6 RLS) is what
   * actually restricts this to documents the ambient portal scope can see,
   * the same "RLS is the primary IDOR defense" discipline as every other
   * portal read. Never regenerates: same stored bytes as the staff path.
   */
  async getDocumentBytesForPortal(companyId: string, id: string): Promise<{ buffer: Buffer; mimeType: string; originalName: string }> {
    const doc = await withTenantTx(this.tenantPrisma, companyId, (tx) =>
      tx.generatedDocument.findFirst({ where: { id } }),
    );
    if (!doc) throw new NotFoundException('Document not found');
    const filePath = this.uploadService.pathFor('document', doc.storedName);
    const buffer = await fs.promises.readFile(filePath);
    return { buffer, mimeType: doc.mimeType, originalName: doc.originalName };
  }

  /** Portal-scoped list (RLS-restricted), filtered to the 3 self-service
   * document types the customer portal exposes (statement, receipt,
   * demand letter) — allotment/reminder letters and broker statements stay
   * staff-only surfaces. */
  async listForPortal(companyId: string, applicantId: string) {
    return withTenantTx(this.tenantPrisma, companyId, (tx) =>
      tx.generatedDocument.findMany({
        where: {
          applicantId,
          documentType: { in: [GENERATED_DOCUMENT_TYPE.STATEMENT, GENERATED_DOCUMENT_TYPE.RECEIPT, GENERATED_DOCUMENT_TYPE.DEMAND_LETTER] },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async listForBooking(companyId: string, bookingId: string) {
    return this.systemPrisma.generatedDocument.findMany({
      where: { companyId, bookingId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listForApplicant(companyId: string, applicantId: string) {
    return this.systemPrisma.generatedDocument.findMany({
      where: { companyId, applicantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── storage helper ─────────────────────────────────────────

  private async store(
    companyId: string,
    buffer: Buffer,
    opts: {
      documentType: GeneratedDocumentTypeValue;
      bookingId?: string;
      applicantId?: string;
      receiptId?: string;
      brokerId?: string;
      templateId?: string;
      originalName: string;
      isDuplicate?: boolean;
      sourceDocumentId?: string;
      createdById: string | null;
    },
  ) {
    const uploaded = await this.uploadService.validateAndStore(
      { buffer, originalname: opts.originalName, size: buffer.length },
      'document',
    );

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.generatedDocument.create({
          data: {
            companyId,
            bookingId: opts.bookingId,
            applicantId: opts.applicantId,
            receiptId: opts.receiptId,
            brokerId: opts.brokerId,
            documentType: opts.documentType,
            templateId: opts.templateId,
            storedName: uploaded.storageName,
            originalName: opts.originalName,
            mimeType: uploaded.mimeType,
            sizeBytes: uploaded.size,
            isDuplicate: opts.isDuplicate ?? false,
            sourceDocumentId: opts.sourceDocumentId,
            createdById: opts.createdById,
          },
        }),
      ),
    );
  }
}
