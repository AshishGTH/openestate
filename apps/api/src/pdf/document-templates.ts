import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';

const PAGE_MARGIN: [number, number, number, number] = [40, 60, 40, 60];

function letterhead(companyName: string, companyAddress: string): Content[] {
  return [
    { text: companyName, style: 'companyName' },
    { text: companyAddress, style: 'companyAddress' },
    {
      canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: '#cccccc' }],
      margin: [0, 8, 0, 12],
    },
  ];
}

const STYLES = {
  companyName: { fontSize: 16, bold: true },
  companyAddress: { fontSize: 9, color: '#555555' },
  docTitle: { fontSize: 14, bold: true, margin: [0, 4, 0, 12] as [number, number, number, number] },
  label: { fontSize: 9, color: '#555555' },
  value: { fontSize: 10, bold: true },
  tableHeader: { fontSize: 9, bold: true, fillColor: '#f1f5f9' },
  tableCell: { fontSize: 9 },
  footer: { fontSize: 8, color: '#888888', italics: true },
};

// ── RECEIPT ──────────────────────────────────────────────────

export interface ReceiptPdfAllocation {
  label: string;
  amountFormatted: string;
}

export interface ReceiptPdfContext {
  receiptNumber: string;
  receiptDate: string;
  bookingNumber: string;
  applicantName: string;
  mode: string;
  instrumentNumber?: string;
  allocations: ReceiptPdfAllocation[];
  grossAmountFormatted: string;
  companyName: string;
  companyAddress: string;
  isDuplicate: boolean;
}

export function buildReceiptDocDefinition(ctx: ReceiptPdfContext): TDocumentDefinitions {
  const allocationRows: TableCell[][] = ctx.allocations.map((a) => [
    { text: a.label, style: 'tableCell' },
    { text: a.amountFormatted, style: 'tableCell', alignment: 'right' },
  ]);

  const content: Content[] = [
    ...letterhead(ctx.companyName, ctx.companyAddress),
    { text: 'PAYMENT RECEIPT', style: 'docTitle' },
    {
      columns: [
        { stack: [{ text: 'Receipt No.', style: 'label' }, { text: ctx.receiptNumber, style: 'value' }] },
        { stack: [{ text: 'Date', style: 'label' }, { text: ctx.receiptDate, style: 'value' }] },
        { stack: [{ text: 'Booking No.', style: 'label' }, { text: ctx.bookingNumber, style: 'value' }] },
      ],
      columnGap: 16,
      margin: [0, 0, 0, 12],
    },
    {
      columns: [
        { stack: [{ text: 'Received From', style: 'label' }, { text: ctx.applicantName, style: 'value' }] },
        {
          stack: [
            { text: 'Mode', style: 'label' },
            {
              text: ctx.instrumentNumber ? `${ctx.mode} (${ctx.instrumentNumber})` : ctx.mode,
              style: 'value',
            },
          ],
        },
      ],
      columnGap: 16,
      margin: [0, 0, 0, 12],
    },
    {
      table: {
        headerRows: 1,
        widths: ['*', 'auto'],
        body: [
          [
            { text: 'Applied Towards', style: 'tableHeader' },
            { text: 'Amount', style: 'tableHeader', alignment: 'right' },
          ],
          ...allocationRows,
          [
            { text: 'Total Received', style: 'tableCell', bold: true },
            { text: ctx.grossAmountFormatted, style: 'tableCell', bold: true, alignment: 'right' },
          ],
        ],
      },
      layout: 'lightHorizontalLines',
    },
    { text: 'This is a computer-generated receipt.', style: 'footer', margin: [0, 24, 0, 0] },
  ];

  return {
    pageMargins: PAGE_MARGIN,
    watermark: ctx.isDuplicate ? { text: 'DUPLICATE', color: '#ff0000', opacity: 0.25, bold: true } : undefined,
    content,
    styles: STYLES,
    defaultStyle: { font: 'Roboto' },
  };
}

// ── STATEMENT ────────────────────────────────────────────────

export interface StatementPdfEntry {
  date: string;
  type: string;
  reason: string;
  debitFormatted: string;
  creditFormatted: string;
  balanceFormatted: string;
}

export interface StatementPdfContext {
  bookingNumber: string;
  applicantName: string;
  projectName: string;
  unitNumber: string;
  statementDate: string;
  entries: StatementPdfEntry[];
  openingBalanceFormatted: string;
  closingBalanceFormatted: string;
  companyName: string;
  companyAddress: string;
}

export function buildStatementDocDefinition(ctx: StatementPdfContext): TDocumentDefinitions {
  const entryRows: TableCell[][] = ctx.entries.map((e) => [
    { text: e.date, style: 'tableCell' },
    { text: e.type, style: 'tableCell' },
    { text: e.reason, style: 'tableCell' },
    { text: e.debitFormatted, style: 'tableCell', alignment: 'right' },
    { text: e.creditFormatted, style: 'tableCell', alignment: 'right' },
    { text: e.balanceFormatted, style: 'tableCell', alignment: 'right' },
  ]);

  const content: Content[] = [
    ...letterhead(ctx.companyName, ctx.companyAddress),
    { text: 'STATEMENT OF ACCOUNT', style: 'docTitle' },
    {
      columns: [
        { stack: [{ text: 'Applicant', style: 'label' }, { text: ctx.applicantName, style: 'value' }] },
        { stack: [{ text: 'Booking No.', style: 'label' }, { text: ctx.bookingNumber, style: 'value' }] },
        { stack: [{ text: 'Unit', style: 'label' }, { text: `${ctx.projectName} — ${ctx.unitNumber}`, style: 'value' }] },
        { stack: [{ text: 'As of', style: 'label' }, { text: ctx.statementDate, style: 'value' }] },
      ],
      columnGap: 12,
      margin: [0, 0, 0, 12],
    },
    { text: `Opening Balance: ${ctx.openingBalanceFormatted}`, style: 'value', margin: [0, 0, 0, 6] },
    {
      table: {
        headerRows: 1,
        widths: ['auto', 'auto', '*', 'auto', 'auto', 'auto'],
        body: [
          [
            { text: 'Date', style: 'tableHeader' },
            { text: 'Type', style: 'tableHeader' },
            { text: 'Description', style: 'tableHeader' },
            { text: 'Debit', style: 'tableHeader', alignment: 'right' },
            { text: 'Credit', style: 'tableHeader', alignment: 'right' },
            { text: 'Balance', style: 'tableHeader', alignment: 'right' },
          ],
          ...entryRows,
        ],
      },
      layout: 'lightHorizontalLines',
    },
    { text: `Closing Balance: ${ctx.closingBalanceFormatted}`, style: 'value', margin: [0, 12, 0, 0] },
  ];

  return {
    pageMargins: PAGE_MARGIN,
    content,
    styles: STYLES,
    defaultStyle: { font: 'Roboto' },
  };
}

// ── BROKER STATEMENT ─────────────────────────────────────────

export interface BrokerStatementPdfEntry {
  date: string;
  bookingNumber: string;
  type: string;
  reason: string;
  debitFormatted: string;
  creditFormatted: string;
  balanceFormatted: string;
}

export interface BrokerStatementPdfContext {
  brokerName: string;
  brokerPhone: string;
  reraAgentNo?: string;
  statementDate: string;
  entries: BrokerStatementPdfEntry[];
  closingBalanceFormatted: string;
  companyName: string;
  companyAddress: string;
}

/**
 * Mirrors buildStatementDocDefinition's shape exactly (typed table of
 * ledger entries, opening/closing balance) rather than routing through
 * LetterTemplate/merge fields — a broker statement is a ledger table, the
 * same document category as the booking statement, not a merge-field
 * letter (allotment/demand/reminder). See CLAUDE.md's Phase 5 decisions.
 */
export function buildBrokerStatementDocDefinition(ctx: BrokerStatementPdfContext): TDocumentDefinitions {
  const entryRows: TableCell[][] = ctx.entries.map((e) => [
    { text: e.date, style: 'tableCell' },
    { text: e.bookingNumber, style: 'tableCell' },
    { text: e.type, style: 'tableCell' },
    { text: e.reason, style: 'tableCell' },
    { text: e.debitFormatted, style: 'tableCell', alignment: 'right' },
    { text: e.creditFormatted, style: 'tableCell', alignment: 'right' },
    { text: e.balanceFormatted, style: 'tableCell', alignment: 'right' },
  ]);

  const content: Content[] = [
    ...letterhead(ctx.companyName, ctx.companyAddress),
    { text: 'BROKER COMMISSION STATEMENT', style: 'docTitle' },
    {
      columns: [
        { stack: [{ text: 'Broker', style: 'label' }, { text: ctx.brokerName, style: 'value' }] },
        { stack: [{ text: 'Phone', style: 'label' }, { text: ctx.brokerPhone, style: 'value' }] },
        { stack: [{ text: 'RERA Agent No.', style: 'label' }, { text: ctx.reraAgentNo || '—', style: 'value' }] },
        { stack: [{ text: 'As of', style: 'label' }, { text: ctx.statementDate, style: 'value' }] },
      ],
      columnGap: 12,
      margin: [0, 0, 0, 12],
    },
    {
      table: {
        headerRows: 1,
        widths: ['auto', 'auto', 'auto', '*', 'auto', 'auto', 'auto'],
        body: [
          [
            { text: 'Date', style: 'tableHeader' },
            { text: 'Booking No.', style: 'tableHeader' },
            { text: 'Type', style: 'tableHeader' },
            { text: 'Description', style: 'tableHeader' },
            { text: 'Debit', style: 'tableHeader', alignment: 'right' },
            { text: 'Credit', style: 'tableHeader', alignment: 'right' },
            { text: 'Balance', style: 'tableHeader', alignment: 'right' },
          ],
          ...entryRows,
        ],
      },
      layout: 'lightHorizontalLines',
    },
    { text: `Outstanding Commission: ${ctx.closingBalanceFormatted}`, style: 'value', margin: [0, 12, 0, 0] },
  ];

  return {
    pageMargins: PAGE_MARGIN,
    content,
    styles: STYLES,
    defaultStyle: { font: 'Roboto' },
  };
}

// ── Merge-field-driven letters (allotment / demand / reminder) ─

export interface LetterPdfContext {
  subject: string;
  body: string;
  companyName: string;
  companyAddress: string;
}

export function buildLetterDocDefinition(ctx: LetterPdfContext): TDocumentDefinitions {
  const content: Content[] = [
    ...letterhead(ctx.companyName, ctx.companyAddress),
    { text: ctx.subject, style: 'docTitle' },
    { text: ctx.body, fontSize: 10, lineHeight: 1.4 },
  ];

  return {
    pageMargins: PAGE_MARGIN,
    content,
    styles: STYLES,
    defaultStyle: { font: 'Roboto' },
  };
}
