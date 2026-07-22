import { z } from 'zod';
import { percentOf } from './money';
import { RECEIPT_MODE } from './finance';

const paise = () => z.coerce.bigint().min(0n);
const isoDate = () => z.coerce.date();

// ── Enums (consts, mirroring finance.ts's LEDGER_ENTRY_TYPE style) ──

export const COMMISSION_ENTRY_TYPE = {
  ACCRUAL: 'ACCRUAL',
  TDS_WITHHELD: 'TDS_WITHHELD',
  PAYMENT: 'PAYMENT',
  CLAWBACK_REVERSAL: 'CLAWBACK_REVERSAL',
  CLAWBACK_RECOVERY: 'CLAWBACK_RECOVERY',
  CLAWBACK_WRITEOFF: 'CLAWBACK_WRITEOFF',
} as const;
export type CommissionEntryTypeValue = (typeof COMMISSION_ENTRY_TYPE)[keyof typeof COMMISSION_ENTRY_TYPE];

export const COMMISSION_PAYMENT_STATUS = {
  REQUESTED: 'REQUESTED',
  APPROVED: 'APPROVED',
  PAID: 'PAID',
  REJECTED: 'REJECTED',
} as const;
export type CommissionPaymentStatusValue = (typeof COMMISSION_PAYMENT_STATUS)[keyof typeof COMMISSION_PAYMENT_STATUS];

export const NOC_STATUS = {
  REQUESTED: 'REQUESTED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;
export type NocStatusValue = (typeof NOC_STATUS)[keyof typeof NOC_STATUS];

export const COMMISSION_TYPE = {
  FLAT_PERCENT: 'FLAT_PERCENT',
  FLAT_AMOUNT: 'FLAT_AMOUNT',
  SLAB: 'SLAB',
} as const;
export type CommissionTypeValue = (typeof COMMISSION_TYPE)[keyof typeof COMMISSION_TYPE];

export const COMMISSION_ACCRUAL_TRIGGER = {
  ON_BOOKING: 'ON_BOOKING',
  ON_COLLECTION_MILESTONE: 'ON_COLLECTION_MILESTONE',
} as const;
export type CommissionAccrualTriggerValue =
  (typeof COMMISSION_ACCRUAL_TRIGGER)[keyof typeof COMMISSION_ACCRUAL_TRIGGER];

export const COMMISSION_CLAWBACK_POLICY = {
  RECOVER: 'RECOVER',
  WRITE_OFF: 'WRITE_OFF',
} as const;
export type CommissionClawbackPolicyValue =
  (typeof COMMISSION_CLAWBACK_POLICY)[keyof typeof COMMISSION_CLAWBACK_POLICY];

/** Entry types that reduce the broker's outstanding without an actual cash payment. */
export const COMMISSION_CLAWBACK_ENTRY_TYPES: readonly CommissionEntryTypeValue[] = [
  COMMISSION_ENTRY_TYPE.CLAWBACK_REVERSAL,
  COMMISSION_ENTRY_TYPE.CLAWBACK_RECOVERY,
  COMMISSION_ENTRY_TYPE.CLAWBACK_WRITEOFF,
];

// ── Zod schemas ───────────────────────────────────────────────

export const createBrokerSchema = z
  .object({
    name: z.string().min(1).max(255),
    phone: z.string().min(1).max(20),
    email: z.string().email().max(255).optional(),
    reraAgentNo: z.string().max(50).optional(),
    pan: z
      .string()
      .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN format')
      .optional(),
  })
  .strict();
export type CreateBrokerDto = z.infer<typeof createBrokerSchema>;

export const updateBrokerSchema = createBrokerSchema.partial();
export type UpdateBrokerDto = z.infer<typeof updateBrokerSchema>;

export const brokerBankDetailSchema = z
  .object({
    accountHolder: z.string().min(1).max(255),
    accountNumber: z.string().min(1).max(30),
    ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC format'),
    bankName: z.string().min(1).max(255),
    isPrimary: z.boolean().default(true),
  })
  .strict();
export type BrokerBankDetailDto = z.infer<typeof brokerBankDetailSchema>;

export const commissionSlabInputSchema = z
  .object({
    seq: z.number().int().min(1),
    fromPaise: paise(),
    /** Omitted = unbounded top ("toPaise IS NULL" in storage). */
    toPaise: paise().optional(),
    ratePercent: z.coerce.number().min(0).max(100),
  })
  .strict();
export type CommissionSlabInput = z.infer<typeof commissionSlabInputSchema>;

/**
 * Collection-percent breakpoints for ON_COLLECTION_MILESTONE accrual mode
 * (e.g. [25, 50, 100]) — monotonic ascending integers in (0, 100], no
 * duplicates. Fails at rule-save time, not accrual time (required change
 * #6b).
 */
export const commissionMilestonesSchema = z
  .array(z.number().int().min(1).max(100))
  .min(1)
  .refine((arr) => arr.every((v, i) => i === 0 || v > arr[i - 1]), {
    message: 'Milestones must be strictly ascending integers in (0, 100] with no duplicates',
  });
export type CommissionMilestones = z.infer<typeof commissionMilestonesSchema>;

const commissionRuleBaseSchema = z
  .object({
    brokerId: z.string().uuid(),
    projectId: z.string().uuid().optional(),
    commissionType: z.nativeEnum(COMMISSION_TYPE),
    flatPercent: z.coerce.number().min(0).max(100).optional(),
    flatPaise: paise().optional(),
    milestones: commissionMilestonesSchema.optional(),
    slabs: z.array(commissionSlabInputSchema).optional(),
  })
  .strict();

export const createCommissionRuleSchema = commissionRuleBaseSchema
  .refine((d) => d.commissionType !== COMMISSION_TYPE.SLAB || (d.slabs && d.slabs.length > 0), {
    message: 'SLAB rules require at least one slab',
    path: ['slabs'],
  })
  .refine((d) => d.commissionType !== COMMISSION_TYPE.FLAT_PERCENT || d.flatPercent !== undefined, {
    message: 'FLAT_PERCENT rules require flatPercent',
    path: ['flatPercent'],
  })
  .refine((d) => d.commissionType !== COMMISSION_TYPE.FLAT_AMOUNT || d.flatPaise !== undefined, {
    message: 'FLAT_AMOUNT rules require flatPaise',
    path: ['flatPaise'],
  });
export type CreateCommissionRuleDto = z.infer<typeof createCommissionRuleSchema>;

/** Partial patch — cross-field constraints (commissionType vs. flat/slab fields) are re-checked in BrokerCommissionRuleService against the merged row, not re-derived here. */
export const updateCommissionRuleSchema = commissionRuleBaseSchema.partial();
export type UpdateCommissionRuleDto = z.infer<typeof updateCommissionRuleSchema>;

export const requestCommissionPaymentSchema = z
  .object({
    brokerId: z.string().uuid(),
    amountPaise: paise().min(1n),
  })
  .strict();
export type RequestCommissionPaymentDto = z.infer<typeof requestCommissionPaymentSchema>;

export const payCommissionPaymentSchema = z
  .object({
    mode: z.nativeEnum(RECEIPT_MODE),
    paymentDate: isoDate(),
    bankId: z.string().uuid().optional(),
    instrumentNumber: z.string().max(50).optional(),
  })
  .strict();
export type PayCommissionPaymentDto = z.infer<typeof payCommissionPaymentSchema>;

export const requestNocSchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict();
export type RequestNocDto = z.infer<typeof requestNocSchema>;

export const rejectNocSchema = z
  .object({
    reason: z.string().min(1).max(500),
  })
  .strict();
export type RejectNocDto = z.infer<typeof rejectNocSchema>;

// ── Slab matching / commission computation (pure, shared, testable) ──

export interface CommissionSlabLike {
  seq: number;
  fromPaise: bigint;
  toPaise: bigint | null;
  // `unknown` rather than `number | string`: callers pass either a plain
  // JSON-decoded number (frontend) or a Prisma Decimal (backend), which
  // isn't structurally a `string`/`number` — always funneled through
  // `Number(x ?? 0)` below regardless of shape.
  ratePercent: unknown;
}

/**
 * Half-open bracket match: [fromPaise, toPaise). A value landing exactly
 * on a boundary matches the HIGHER bracket (see BrokerCommissionSlab's
 * schema doc comment). Slabs must be contiguous and gapless with exactly
 * one unbounded (toPaise = null) top slab — validated at rule-save time
 * by `validateSlabContiguity`, assumed already-valid here.
 */
export function matchCommissionSlab<T extends CommissionSlabLike>(basisPaise: bigint, slabs: T[]): T {
  const sorted = [...slabs].sort((a, b) => a.seq - b.seq);
  const match = sorted.find((s) => basisPaise >= s.fromPaise && (s.toPaise === null || basisPaise < s.toPaise));
  if (!match) {
    throw new Error(
      'No matching commission slab for the given basis amount — slabs must be contiguous and gapless with an unbounded top slab',
    );
  }
  return match;
}

/** Slabs sorted by seq must be contiguous ([i].toPaise === [i+1].fromPaise) and end unbounded. */
export function validateSlabContiguity(slabs: CommissionSlabInput[]): { valid: boolean; error?: string } {
  if (slabs.length === 0) return { valid: false, error: 'At least one slab is required' };
  const sorted = [...slabs].sort((a, b) => a.seq - b.seq);
  if (sorted[0].fromPaise !== 0n) return { valid: false, error: 'The first slab must start at 0' };
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].toPaise === undefined) {
      return { valid: false, error: `Slab seq=${sorted[i].seq} must have a toPaise — only the last slab can be unbounded` };
    }
    if (sorted[i].toPaise !== sorted[i + 1].fromPaise) {
      return {
        valid: false,
        error: `Slabs must be contiguous: seq=${sorted[i].seq}'s toPaise must equal seq=${sorted[i + 1].seq}'s fromPaise`,
      };
    }
  }
  if (sorted[sorted.length - 1].toPaise !== undefined) {
    return { valid: false, error: 'The last slab (highest seq) must be unbounded (no toPaise)' };
  }
  return { valid: true };
}

export interface CommissionRuleLike {
  commissionType: string;
  // See CommissionSlabLike.ratePercent — same Decimal-vs-plain-number reasoning.
  flatPercent?: unknown;
  flatPaise?: bigint | null;
}

/** Computes the total commission basis once — the snapshot value stored on BrokerBookingCommission. */
export function computeCommissionPaise(
  basisPaise: bigint,
  rule: CommissionRuleLike,
  slabs?: CommissionSlabLike[],
): bigint {
  if (rule.commissionType === COMMISSION_TYPE.FLAT_AMOUNT) {
    return rule.flatPaise ?? 0n;
  }
  if (rule.commissionType === COMMISSION_TYPE.FLAT_PERCENT) {
    return percentOf(basisPaise, Math.round(Number(rule.flatPercent ?? 0) * 100));
  }
  const matched = matchCommissionSlab(basisPaise, slabs ?? []);
  return percentOf(basisPaise, Math.round(Number(matched.ratePercent) * 100));
}

// ── Phase 4 hand-off: consuming BookingCancelledEvent ───────────
// See CancellationService (frozen) and BookingCancelledEvent in finance.ts.
// CommissionService.handleBookingCancelled takes the event's bookingId/
// companyId/cancellationType and looks up the real broker via
// Booking.brokerId — event.brokerId itself is always null coming out of
// CancellationService (Phase 4 predates brokers) and is not relied upon.
