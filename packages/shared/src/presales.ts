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

// ── Inquiry list search ─────────────────────────────────────

/** A search term shorter than this is ignored (the list is returned unfiltered). */
export const INQUIRY_SEARCH_MIN_LENGTH = 2;
/** Digits needed before a term is also matched against phone numbers. */
export const INQUIRY_SEARCH_MIN_PHONE_DIGITS = 3;

/**
 * Escapes the characters that are special in a SQL LIKE pattern (`%`, `_` and the
 * escape character `\\` itself) so user text matches literally. Prisma binds the
 * value as a parameter but does NOT escape LIKE wildcards inside `contains`, so
 * without this a search for `%%` matches every row.
 */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, '\\$&');
}

export interface InquirySearchTerms {
  /** The trimmed, whitespace-collapsed text, matched case-insensitively against name/email/project. */
  text: string;
  /**
   * Digit strings to match against phone numbers. Empty when the term is not
   * phone-like. Holds the digits as typed plus the same digits with an Indian
   * country/trunk prefix removed, so "+91 98765", "098765" and "98765" all find
   * 9876543210 (stored normalised, see `normalizePhone`).
   */
  phoneDigits: string[];
}

/**
 * Turns the raw `search` query parameter into safe match terms, or null when
 * there is nothing to search for. Pure: no I/O, so the rules are unit-tested
 * without a database. The terms are only ever passed to Prisma as bound
 * parameters (`contains`), never spliced into SQL.
 */
export function buildInquirySearchTerms(raw: string | undefined | null): InquirySearchTerms | null {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < INQUIRY_SEARCH_MIN_LENGTH) return null;

  const phoneLike = /^\+?[\d\s().-]+$/.test(text);
  const digits = text.replace(/\D/g, '');
  const phoneDigits: string[] = [];
  if (phoneLike && digits.length >= INQUIRY_SEARCH_MIN_PHONE_DIGITS) {
    phoneDigits.push(digits);
    // "+91 ..." / "91 ..." / "0 ...": also try without the prefix normalizePhone strips.
    const stripped = text.startsWith('+91') || /^91\s/.test(text) ? digits.slice(2) : digits.startsWith('0') ? digits.slice(1) : '';
    if (stripped.length >= INQUIRY_SEARCH_MIN_PHONE_DIGITS) phoneDigits.push(stripped);
  }
  return { text, phoneDigits };
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Canonical (a, b) ordering for ApplicantDistinctPair, lexicographic on
 *  the UUID string — the pair is always stored applicantAId < applicantBId
 *  so a lookup never needs to check both orderings. */
export function orderApplicantPair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
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

/** An inquiry counts as "actively worked" — the axis overdueOnly filters
 *  and escalation eligibility both key off — whenever status is one of
 *  these. An OPEN lead with a slipped follow-up and a CONTINUED lead with
 *  a slipped follow-up are equally overdue; DUMPED/SUCCESSFUL are terminal
 *  and never overdue regardless of nextFollowupAt. */
export const ACTIVE_INQUIRY_STATUSES = [INQUIRY_STATUS.OPEN, INQUIRY_STATUS.CONTINUED] as const;

// ── Inquiry list query (GET /inquiries) ─────────────────────

/**
 * The only fields GET /inquiries may be sorted by. `sortBy` used to be passed
 * straight into the ORM, so any inquiry column (or a bad name, which threw a
 * 500) was accepted; anything not listed here is now a 400.
 */
export const INQUIRY_SORT_FIELDS = ['createdAt', 'updatedAt', 'nextFollowupAt', 'status'] as const;
export type InquirySortField = (typeof INQUIRY_SORT_FIELDS)[number];

const STATUS_VALUES = Object.values(INQUIRY_STATUS) as [InquiryStatusValue, ...InquiryStatusValue[]];

/** `?status=OPEN,CONTINUED` or repeated `?status=OPEN&status=CONTINUED`. Empty means "not filtering". */
const statusListSchema = z.preprocess(
  (v) => {
    const raw = Array.isArray(v) ? v.join(',') : v;
    if (typeof raw !== 'string') return raw;
    const parts = raw.split(',').map((p) => p.trim()).filter((p) => p !== '');
    return parts.length === 0 ? undefined : [...new Set(parts)];
  },
  z.array(z.enum(STATUS_VALUES)).min(1).optional(),
);

/**
 * An instant with an explicit offset ("2026-10-01T00:00:00+05:30" or "...Z").
 * Date-only or offset-less strings are rejected: they would be silently read as
 * UTC and a client in another zone would get the wrong day.
 */
const instantSchema = z
  .string()
  .datetime({ offset: true, message: 'Must be an ISO 8601 instant with a time zone offset, e.g. 2026-10-01T00:00:00+05:30 or ...Z' })
  .transform((v) => new Date(v));

/** `me` (the caller) or a user id inside the caller's visible team. */
const assignedToSchema = z.union([z.literal('me'), z.string().uuid()]);

export const inquiryListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().max(255).optional(),
    status: statusListSchema,
    sortBy: z.enum(INQUIRY_SORT_FIELDS).optional(),
    sortOrder: z.enum(['asc', 'desc']).default('asc'),
    /** Inclusive lower bound on `nextFollowupAt`. */
    followUpAfter: instantSchema.optional(),
    /** Exclusive upper bound on `nextFollowupAt`. */
    followUpBefore: instantSchema.optional(),
    /** Only `none` (no follow-up date set) is supported. */
    followUp: z.enum(['none']).optional(),
    assignedTo: assignedToSchema.optional(),
  })
  .superRefine((q, ctx) => {
    if (q.followUp === 'none' && (q.followUpAfter || q.followUpBefore)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['followUp'], message: 'followUp=none cannot be combined with followUpAfter or followUpBefore' });
    }
    if (q.followUpAfter && q.followUpBefore && q.followUpAfter >= q.followUpBefore) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['followUpBefore'], message: 'followUpBefore must be later than followUpAfter' });
    }
  });

export type InquiryListQuery = z.infer<typeof inquiryListQuerySchema>;

// ── Inquiry summary (GET /inquiries/summary) ────────────────

/** A "day" is at most this long: 25 h covers a DST fall-back, the rest is slack. */
export const INQUIRY_SUMMARY_MAX_DAY_MS = 26 * 3_600_000;

export const inquirySummaryQuerySchema = z
  .object({
    /** Start (inclusive) of the caller's "today". Omitted: the company's day (CompanyConfig.timezone). */
    dayStart: instantSchema.optional(),
    /** End (exclusive) of the caller's "today". Must be given together with dayStart. */
    dayEnd: instantSchema.optional(),
    /** Count leads created at or after this instant as "new". Default: dayEnd minus 7 days. */
    since: instantSchema.optional(),
    assignedTo: assignedToSchema.optional(),
  })
  .superRefine((q, ctx) => {
    if (!!q.dayStart !== !!q.dayEnd) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dayEnd'], message: 'dayStart and dayEnd must be given together' });
      return;
    }
    if (q.dayStart && q.dayEnd) {
      const span = q.dayEnd.getTime() - q.dayStart.getTime();
      if (span <= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dayEnd'], message: 'dayEnd must be later than dayStart' });
      else if (span > INQUIRY_SUMMARY_MAX_DAY_MS) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dayEnd'], message: 'A day cannot be longer than 26 hours' });
    }
  });

export type InquirySummaryQuery = z.infer<typeof inquirySummaryQuerySchema>;

/** Seeded default pipeline — India-first per CLAUDE.md, matches the set
 *  the requester approved for Phase 0 of the lead-stage foundation.
 *  "New" is the isDefault stage. Order is the seeded sortOrder. */
export const DEFAULT_LEAD_STAGES = [
  'New',
  'Contacted',
  'Site Visit Scheduled',
  'Site Visit Done',
  'Negotiation',
  'Documentation',
] as const;

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
    pan: z
      .string()
      .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN format')
      .optional(),
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

/** The opposite decision from merge — "these are different people," not
 *  "these are the same." See ApplicantDistinctPair (packages/db). */
export const confirmDistinctSchema = z
  .object({
    otherApplicantId: z.string().uuid(),
  })
  .strict();

export type ConfirmDistinctDto = z.infer<typeof confirmDistinctSchema>;

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
    // Omitted -> InquiryService.create() resolves the company's isDefault
    // LeadStage (or leaves it null if none configured). Explicit null is
    // not accepted here — there is no "no stage" gesture at creation, only
    // "let the default apply."
    stageId: z.string().uuid().optional(),
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
    // Never nullable — a lead's stage isn't unset once assigned, only
    // ever moved to a different stage. See LeadStage's own doc comment.
    stageId: z.string().uuid().optional(),
    status: z.nativeEnum(INQUIRY_STATUS).optional(),
    // Required by InquiryService.update() when status is transitioning
    // to DUMPED (SOP rule 5) — not expressible here since that's
    // conditional on the transition itself, which zod can't see. Not
    // persisted on Inquiry at all; carried through to the
    // InquiryDispositionHistory row only.
    dumpReasonId: z.string().uuid().optional(),
    dumpRemarks: z.string().max(2000).optional(),
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

// ── Zod Schemas: Lead stage ─────────────────────────────────

export const createLeadStageSchema = z
  .object({
    name: z.string().min(1).max(255),
    sortOrder: z.number().int().min(0).default(0),
    isActive: z.boolean().default(true),
    isDefault: z.boolean().default(false),
  })
  .strict();

export type CreateLeadStageDto = z.infer<typeof createLeadStageSchema>;

/**
 * `reassignToStageId` is required, not optional-with-a-default, whenever
 * `isActive: false` is being set on an occupied stage — enforced in
 * LeadStageService, not expressible statically here (it depends on live
 * occupancy, which zod can't see). Omitting it against an unoccupied
 * stage, or against a stage that's staying active, is fine.
 */
export const updateLeadStageSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    sortOrder: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    reassignToStageId: z.string().uuid().optional(),
  })
  .strict();

export type UpdateLeadStageDto = z.infer<typeof updateLeadStageSchema>;

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
    // When the interaction happened — distinct from nextActionAt (when
    // the NEXT one is due). Omitted -> FollowUpService.create() defaults
    // to the injected Clock's now(); provided -> lets a rep log a call
    // that happened earlier (yesterday, this morning) rather than only
    // "right now."
    interactionAt: z.coerce.date().optional(),
    // Required by FollowUpService.create() whenever the inquiry is
    // currently OPEN/CONTINUED (SOP rule 2) — not expressible here since
    // that depends on live inquiry state, which zod can't see.
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
