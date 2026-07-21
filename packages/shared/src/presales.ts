import { z } from 'zod';

// ── Clock (injectable "now" for deterministic ageing/escalation) ──

export interface Clock {
  now(): Date;
}

export const SYSTEM_CLOCK: Clock = { now: () => new Date() };

// ── Phone / email normalization ─────────────────────────────
//
// Phone: strip Indian country/trunk prefixes (+91/91/0) and normalize
// ONLY if the result is a 10-digit number starting 6-9 (a valid Indian
// mobile). Anything else (NRI numbers, landlines, malformed input) is
// stored as-is (trimmed only) and matched by exact string equality —
// never digit-stripped, never guessed at. See CLAUDE.md Phase 3 decisions.

export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, '');

  if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return digits;
  }

  return trimmed;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// ── Ageing / overdue calculations (pure, testable with injected `now`) ──

export const AGEING_BUCKETS = ['0-7', '8-30', '31-90', '90+'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export function computeAgeingBucket(createdAt: Date, now: Date): AgeingBucket {
  const ageDays = Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000);
  if (ageDays <= 7) return '0-7';
  if (ageDays <= 30) return '8-30';
  if (ageDays <= 90) return '31-90';
  return '90+';
}

export function isFollowUpOverdue(nextFollowupAt: Date | null | undefined, now: Date): boolean {
  return !!nextFollowupAt && nextFollowupAt.getTime() < now.getTime();
}

/** An inquiry is eligible for (re-)escalation if it has never been escalated,
 *  or its last escalation predates the currently-overdue nextFollowupAt
 *  (i.e. the follow-up date was pushed forward and has lapsed again). */
export function isEscalationEligible(
  nextFollowupAt: Date | null | undefined,
  lastEscalatedAt: Date | null | undefined,
  now: Date,
): boolean {
  if (!isFollowUpOverdue(nextFollowupAt, now)) return false;
  if (!lastEscalatedAt) return true;
  return lastEscalatedAt.getTime() < (nextFollowupAt as Date).getTime();
}

// ── Inquiry status / follow-up outcome / communication enums ──

export const INQUIRY_STATUS = {
  OPEN: 'OPEN',
  CONTINUED: 'CONTINUED',
  DUMPED: 'DUMPED',
  SUCCESSFUL: 'SUCCESSFUL',
} as const;
export type InquiryStatusValue = (typeof INQUIRY_STATUS)[keyof typeof INQUIRY_STATUS];

export const FOLLOW_UP_OUTCOME = {
  COMPLETED: 'COMPLETED',
  NO_RESPONSE: 'NO_RESPONSE',
  RESCHEDULED: 'RESCHEDULED',
  NOT_INTERESTED: 'NOT_INTERESTED',
  CONVERTED: 'CONVERTED',
} as const;
export type FollowUpOutcomeValue = (typeof FOLLOW_UP_OUTCOME)[keyof typeof FOLLOW_UP_OUTCOME];

export const COMMUNICATION_CHANNEL = { EMAIL: 'EMAIL', SMS: 'SMS' } as const;
export type CommunicationChannelValue = (typeof COMMUNICATION_CHANNEL)[keyof typeof COMMUNICATION_CHANNEL];

export const ASSIGNMENT_TYPE = { MANUAL: 'manual', AUTO: 'auto' } as const;
export type AssignmentTypeValue = (typeof ASSIGNMENT_TYPE)[keyof typeof ASSIGNMENT_TYPE];

// ── Zod Schemas: Applicant ──────────────────────────────────

export const createApplicantSchema = z
  .object({
    name: z.string().min(1).max(255),
    primaryPhone: z.string().min(1).max(20),
    alternatePhones: z.array(z.string().max(20)).default([]),
    email: z.string().email().max(255).optional(),
    addressLine1: z.string().max(255).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    pincode: z.string().max(10).optional(),
    customFields: z.record(z.unknown()).optional(),
  })
  .strict();

export type CreateApplicantDto = z.infer<typeof createApplicantSchema>;

export const updateApplicantSchema = createApplicantSchema.partial().strict();
export type UpdateApplicantDto = z.infer<typeof updateApplicantSchema>;

export const recordConsentSchema = z
  .object({
    given: z.boolean(),
    source: z.string().max(100).optional(),
  })
  .strict();

export type RecordConsentDto = z.infer<typeof recordConsentSchema>;

// ── Zod Schemas: Inquiry ────────────────────────────────────

export const createInquirySchema = z
  .object({
    applicantId: z.string().uuid().optional(),
    applicant: createApplicantSchema.optional(),
    projectId: z.string().uuid().optional(),
    sourceId: z.string().uuid().optional(),
    inquiryTypeId: z.string().uuid().optional(),
    budgetMinPaise: z.coerce.bigint().min(0n).optional(),
    budgetMaxPaise: z.coerce.bigint().min(0n).optional(),
    preferredUnitTypeId: z.string().uuid().optional(),
    temperatureId: z.string().uuid().optional(),
    nextFollowupAt: z.coerce.date().optional(),
    customFields: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((d) => !!d.applicantId || !!d.applicant, {
    message: 'Either applicantId or applicant must be provided',
    path: ['applicantId'],
  });

export type CreateInquiryDto = z.infer<typeof createInquirySchema>;

export const updateInquirySchema = z
  .object({
    projectId: z.string().uuid().optional(),
    sourceId: z.string().uuid().optional(),
    inquiryTypeId: z.string().uuid().optional(),
    budgetMinPaise: z.coerce.bigint().min(0n).optional(),
    budgetMaxPaise: z.coerce.bigint().min(0n).optional(),
    preferredUnitTypeId: z.string().uuid().optional(),
    temperatureId: z.string().uuid().optional(),
    status: z.nativeEnum(INQUIRY_STATUS).optional(),
    nextFollowupAt: z.coerce.date().nullable().optional(),
    customFields: z.record(z.unknown()).optional(),
  })
  .strict();

export type UpdateInquiryDto = z.infer<typeof updateInquirySchema>;

export const assignInquirySchema = z
  .object({
    toUserId: z.string().uuid(),
    reason: z.string().max(500).optional(),
  })
  .strict();

export type AssignInquiryDto = z.infer<typeof assignInquirySchema>;

// ── Zod Schemas: Assignment pool ────────────────────────────

export const upsertAssignmentPoolSchema = z
  .object({
    isActive: z.boolean().default(true),
    pausedReason: z.string().max(100).optional(),
  })
  .strict();

export type UpsertAssignmentPoolDto = z.infer<typeof upsertAssignmentPoolSchema>;

// ── Zod Schemas: Follow-up ──────────────────────────────────

export const createFollowUpSchema = z
  .object({
    typeId: z.string().uuid().optional(),
    notes: z.string().max(5000).optional(),
    outcome: z.nativeEnum(FOLLOW_UP_OUTCOME).optional(),
    nextActionAt: z.coerce.date().optional(),
    scheduledAt: z.coerce.date().optional(),
    venue: z.string().max(255).optional(),
  })
  .strict();

export type CreateFollowUpDto = z.infer<typeof createFollowUpSchema>;

export const updateFollowUpSchema = createFollowUpSchema.partial().strict();
export type UpdateFollowUpDto = z.infer<typeof updateFollowUpSchema>;

// ── Zod Schemas: Communication send ─────────────────────────

export const sendCommunicationSchema = z
  .object({
    channel: z.nativeEnum(COMMUNICATION_CHANNEL),
    subject: z.string().max(500).optional(),
    body: z.string().min(1),
  })
  .strict();

export type SendCommunicationDto = z.infer<typeof sendCommunicationSchema>;

// ── Zod Schemas: SMS template (DLT fields) ──────────────────

export const createSmsTemplateSchema = z
  .object({
    name: z.string().min(1).max(255),
    dltTemplateId: z.string().min(1).max(50),
    senderId: z.string().min(1).max(11),
    headerId: z.string().max(50).optional(),
    body: z.string().min(1),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).default(0),
  })
  .strict();

export type CreateSmsTemplateDto = z.infer<typeof createSmsTemplateSchema>;

export const updateSmsTemplateSchema = createSmsTemplateSchema.partial().strict();
export type UpdateSmsTemplateDto = z.infer<typeof updateSmsTemplateSchema>;

// ── Zod Schemas: Inquiry import row ─────────────────────────

export const importInquiryRowSchema = z.object({
  applicantName: z.string().min(1).max(255),
  primaryPhone: z.string().min(1).max(20),
  email: z.string().email().max(255).optional(),
  projectCode: z.string().max(50).optional(),
  sourceName: z.string().max(255).optional(),
  inquiryTypeName: z.string().max(255).optional(),
  budgetMinPaise: z.coerce.number().int().min(0).optional(),
  budgetMaxPaise: z.coerce.number().int().min(0).optional(),
  notes: z.string().max(2000).optional(),
});

export type ImportInquiryRow = z.infer<typeof importInquiryRowSchema>;
