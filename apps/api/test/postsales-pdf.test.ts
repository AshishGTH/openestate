/**
 * PDF snapshot tests: one per document template type, against a FIXED
 * fixture context. No DB dependency (PdfService is a pure docDefinition →
 * Buffer function), so these always run — never skipped.
 *
 * "Snapshot" here means structural, not pixel-diff: we assert (a) valid PDF
 * framing (%PDF header / %%EOF trailer), (b) a deterministic byte length for
 * a fixed fixture (rendered twice, compared — proves reproducibility without
 * hardcoding a magic number that could drift across pdfkit/zlib versions),
 * and (c) a first-page structural fact pulled straight from the PDF object
 * dictionary (page count via `/Type /Page`), which stays in plaintext even
 * though pdfkit compresses content streams.
 */
import { describe, it, expect } from 'vitest';
import { PdfService } from '../src/pdf/pdf.service';
import {
  buildReceiptDocDefinition,
  buildStatementDocDefinition,
  buildLetterDocDefinition,
  type ReceiptPdfContext,
  type StatementPdfContext,
} from '../src/pdf/document-templates';

const pdf = new PdfService();

function assertValidSinglePagePdf(buffer: Buffer) {
  const head = buffer.subarray(0, 8).toString('latin1');
  expect(head.startsWith('%PDF-1.')).toBe(true);
  const tail = buffer.subarray(-16).toString('latin1');
  expect(tail.includes('%%EOF')).toBe(true);

  const text = buffer.toString('latin1');
  const pageMatches = text.match(/\/Type\s*\/Page(?!s)/g) ?? [];
  expect(pageMatches.length).toBe(1);
}

const FIXED_RECEIPT_CTX: ReceiptPdfContext = {
  receiptNumber: 'RCP/2026-27/000001',
  receiptDate: '2026-06-16',
  bookingNumber: 'BKG/2026-27/000001',
  applicantName: 'Test Applicant',
  mode: 'NEFT',
  allocations: [{ label: 'Installment 1', amountFormatted: '₹10,00,000.00' }],
  grossAmountFormatted: '₹10,00,000.00',
  companyName: 'Test Company',
  companyAddress: '123 Test Street',
  isDuplicate: false,
};

const FIXED_STATEMENT_CTX: StatementPdfContext = {
  bookingNumber: 'BKG/2026-27/000001',
  applicantName: 'Test Applicant',
  projectName: 'Test Project',
  unitNumber: 'A-101',
  statementDate: '2026-07-21',
  entries: [
    { date: '2026-06-01', type: 'CHARGE', reason: 'Base Sale Price', debitFormatted: '₹30,00,000.00', creditFormatted: '', balanceFormatted: '₹30,00,000.00' },
    { date: '2026-06-16', type: 'RECEIPT_ALLOC', reason: '', debitFormatted: '', creditFormatted: '₹10,00,000.00', balanceFormatted: '₹20,00,000.00' },
  ],
  openingBalanceFormatted: '₹0.00',
  closingBalanceFormatted: '₹20,00,000.00',
  companyName: 'Test Company',
  companyAddress: '123 Test Street',
};

describe('PDF templates: structural snapshot per document type', () => {
  it('RECEIPT renders a valid, single-page, deterministic PDF', async () => {
    const doc = buildReceiptDocDefinition(FIXED_RECEIPT_CTX);
    const buf1 = await pdf.render(doc);
    const buf2 = await pdf.render(buildReceiptDocDefinition(FIXED_RECEIPT_CTX));

    assertValidSinglePagePdf(buf1);
    expect(buf1.length).toBeGreaterThan(1000);
    expect(buf1.length).toBe(buf2.length); // deterministic for a fixed fixture
  });

  it('RECEIPT reprint (isDuplicate=true) renders a watermarked PDF distinct in size from the original', async () => {
    const original = await pdf.render(buildReceiptDocDefinition(FIXED_RECEIPT_CTX));
    const duplicate = await pdf.render(buildReceiptDocDefinition({ ...FIXED_RECEIPT_CTX, isDuplicate: true }));

    assertValidSinglePagePdf(duplicate);
    expect(duplicate.length).not.toBe(original.length);
  });

  it('STATEMENT renders a valid, single-page, deterministic PDF', async () => {
    const buf1 = await pdf.render(buildStatementDocDefinition(FIXED_STATEMENT_CTX));
    const buf2 = await pdf.render(buildStatementDocDefinition(FIXED_STATEMENT_CTX));

    assertValidSinglePagePdf(buf1);
    expect(buf1.length).toBeGreaterThan(1000);
    expect(buf1.length).toBe(buf2.length);
  });

  it.each(['ALLOTMENT_LETTER', 'DEMAND_LETTER', 'REMINDER_LETTER'])(
    '%s renders a valid, single-page, deterministic PDF',
    async (label) => {
      const ctx = {
        subject: `${label} — Test Subject`,
        body: `Dear Test Applicant,\n\nThis is a fixed-fixture body for ${label}.`,
        companyName: 'Test Company',
        companyAddress: '123 Test Street',
      };
      const buf1 = await pdf.render(buildLetterDocDefinition(ctx));
      const buf2 = await pdf.render(buildLetterDocDefinition(ctx));

      assertValidSinglePagePdf(buf1);
      expect(buf1.length).toBeGreaterThan(500);
      expect(buf1.length).toBe(buf2.length);
    },
  );
});
