import { z } from 'zod';

// ── Generated document / dispatch enums ─────────────────────

export const GENERATED_DOCUMENT_TYPE = {
  STATEMENT: 'STATEMENT',
  RECEIPT: 'RECEIPT',
  ALLOTMENT_LETTER: 'ALLOTMENT_LETTER',
  DEMAND_LETTER: 'DEMAND_LETTER',
  REMINDER_LETTER: 'REMINDER_LETTER',
  BROKER_STATEMENT: 'BROKER_STATEMENT',
} as const;
export type GeneratedDocumentTypeValue =
  (typeof GENERATED_DOCUMENT_TYPE)[keyof typeof GENERATED_DOCUMENT_TYPE];

export const DISPATCH_CHANNEL = { EMAIL: 'EMAIL', SMS: 'SMS' } as const;
export type DispatchChannelValue = (typeof DISPATCH_CHANNEL)[keyof typeof DISPATCH_CHANNEL];

export const DISPATCH_STATUS = { QUEUED: 'QUEUED', SENT: 'SENT', FAILED: 'FAILED' } as const;
export type DispatchStatusValue = (typeof DISPATCH_STATUS)[keyof typeof DISPATCH_STATUS];

// ── Merge field registry ─────────────────────────────────────
//
// This IS the single source of truth for which {{field}} tokens are valid in
// a LetterTemplate body for a given document type. The TS context type for
// each document type is DERIVED from this object (via MergeFieldsFor<T>), so
// the registry and the type can never drift apart. A template body containing
// a token not listed here fails `validateTemplateMergeFields` — callable in a
// plain unit test against just the body string, with no rendering and no real
// data — so a typo'd merge field is caught at TEST TIME, not at render time
// against a real booking.
//
// Money fields are pre-formatted strings (via the shared Money formatInr),
// never raw BigInt — merge is always string-in, string-out.

export const MERGE_FIELD_REGISTRY = {
  STATEMENT: [
    'applicantName',
    'bookingNumber',
    'projectName',
    'unitNumber',
    'statementDate',
    'openingBalanceFormatted',
    'closingBalanceFormatted',
    'companyName',
    'companyAddress',
  ],
  RECEIPT: [
    'applicantName',
    'receiptNumber',
    'receiptDate',
    'bookingNumber',
    'amountFormatted',
    'mode',
    'companyName',
    'companyAddress',
  ],
  ALLOTMENT_LETTER: [
    'applicantName',
    'bookingNumber',
    'unitNumber',
    'projectName',
    'towerName',
    'floorLabel',
    'agreedPriceFormatted',
    'allotmentDate',
    'companyName',
    'companyAddress',
  ],
  DEMAND_LETTER: [
    'applicantName',
    'bookingNumber',
    'installmentLabel',
    'dueDate',
    'dueAmountFormatted',
    'projectName',
    'unitNumber',
    'companyName',
    'companyAddress',
  ],
  REMINDER_LETTER: [
    'applicantName',
    'bookingNumber',
    'installmentLabel',
    'dueDate',
    'overdueDays',
    'dueAmountFormatted',
    'companyName',
    'companyAddress',
  ],
  // Not currently rendered through resolveMergeFields — buildBrokerStatementDocDefinition
  // (apps/api/src/pdf/document-templates.ts) is a typed ledger-table template, the
  // same category as STATEMENT, not a merge-field letter. Listed here anyway
  // so MERGE_FIELD_REGISTRY stays exhaustive over GeneratedDocumentTypeValue.
  BROKER_STATEMENT: [
    'brokerName',
    'brokerPhone',
    'reraAgentNo',
    'statementDate',
    'closingBalanceFormatted',
    'companyName',
    'companyAddress',
  ],
} as const satisfies Record<GeneratedDocumentTypeValue, readonly string[]>;

export type MergeFieldsFor<T extends GeneratedDocumentTypeValue> =
  (typeof MERGE_FIELD_REGISTRY)[T][number];

export type MergeContext<T extends GeneratedDocumentTypeValue> = Record<MergeFieldsFor<T>, string>;

const MERGE_TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** All `{{field}}` tokens referenced in a template body (unique, order of first appearance). */
export function extractMergeTokens(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(MERGE_TOKEN_RE)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

/**
 * Validate a template body against the merge-field registry for a document
 * type — WITHOUT rendering or needing real data. Call this from a template
 * admin-save path and/or a unit test; a typo'd field name fails here, not
 * when someone eventually tries to print a real letter.
 */
export function validateTemplateMergeFields(
  body: string,
  documentType: GeneratedDocumentTypeValue,
): { valid: boolean; unknownFields: string[] } {
  const allowed = new Set<string>(MERGE_FIELD_REGISTRY[documentType]);
  const unknownFields = extractMergeTokens(body).filter((t) => !allowed.has(t));
  return { valid: unknownFields.length === 0, unknownFields };
}

/** Resolve `{{field}}` tokens in a template body against a typed context. Throws on any unknown field. */
export function resolveMergeFields<T extends GeneratedDocumentTypeValue>(
  body: string,
  documentType: T,
  context: MergeContext<T>,
): string {
  const { valid, unknownFields } = validateTemplateMergeFields(body, documentType);
  if (!valid) {
    throw new Error(
      `Unknown merge field(s) for ${documentType}: ${unknownFields.join(', ')}. ` +
        `Allowed: ${MERGE_FIELD_REGISTRY[documentType].join(', ')}`,
    );
  }
  return body.replace(MERGE_TOKEN_RE, (_, field: string) => context[field as MergeFieldsFor<T>] ?? '');
}

// ── Zod schemas ───────────────────────────────────────────────

export const sendDispatchSchema = z
  .object({
    generatedDocumentId: z.string().uuid().optional(),
    recipientAddress: z.string().min(1).max(255),
    channel: z.nativeEnum(DISPATCH_CHANNEL),
  })
  .strict();
export type SendDispatchDto = z.infer<typeof sendDispatchSchema>;

export const generateDocumentSchema = z
  .object({
    documentType: z.nativeEnum(GENERATED_DOCUMENT_TYPE),
    bookingId: z.string().uuid().optional(),
    applicantId: z.string().uuid().optional(),
    templateId: z.string().uuid().optional(),
    installmentId: z.string().uuid().optional(),
  })
  .strict()
  .refine((d) => !!d.bookingId || !!d.applicantId, {
    message: 'Either bookingId or applicantId is required',
  });
export type GenerateDocumentDto = z.infer<typeof generateDocumentSchema>;

export const saveBookingDraftSchema = z
  .object({
    label: z.string().max(255).optional(),
    draftData: z.record(z.unknown()),
  })
  .strict();
export type SaveBookingDraftDto = z.infer<typeof saveBookingDraftSchema>;

export const reportDateRangeSchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    projectId: z.string().uuid().optional(),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .strict();
export type ReportDateRangeQuery = z.infer<typeof reportDateRangeSchema>;
