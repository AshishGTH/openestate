import { z } from 'zod';

export const createMasterSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(500).optional(),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).default(0),
  })
  .strict();

export type CreateMasterDto = z.infer<typeof createMasterSchema>;

export const updateMasterSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(500).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .strict();

export type UpdateMasterDto = z.infer<typeof updateMasterSchema>;

export const createGstRateSchema = z
  .object({
    rate: z.number().min(0).max(100),
    description: z.string().min(1).max(255),
    effectiveFrom: z.coerce.date(),
    // .nullable() must come BEFORE .optional() so an explicit `null` short-
    // circuits ZodNullable and never reaches z.coerce.date()'s `new Date(x)`
    // coercion — `new Date(null)` is a valid Date (epoch), not an error, so
    // without .nullable() a caller's explicit "clear this field" (null) was
    // silently coerced to 1970-01-01 instead of clearing the column. Omitted
    // (undefined) still means "leave unchanged" on update, "open-ended" on
    // create — only explicit null now means "clear".
    effectiveTo: z.coerce.date().nullable().optional(),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).default(0),
  })
  .strict();

export type CreateGstRateDto = z.infer<typeof createGstRateSchema>;

export const updateGstRateSchema = createGstRateSchema.partial().strict();
export type UpdateGstRateDto = z.infer<typeof updateGstRateSchema>;

export const createTdsRuleSchema = z
  .object({
    section: z.string().min(1).max(20),
    ratePercent: z.number().min(0).max(100),
    thresholdPaise: z.coerce.bigint().min(0n),
    effectiveFrom: z.coerce.date(),
    // See createGstRateSchema's effectiveTo comment — same null-vs-undefined
    // fix, same reason.
    effectiveTo: z.coerce.date().nullable().optional(),
    description: z.string().max(255).optional(),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).default(0),
  })
  .strict();

export type CreateTdsRuleDto = z.infer<typeof createTdsRuleSchema>;

export const updateTdsRuleSchema = createTdsRuleSchema.partial().strict();
export type UpdateTdsRuleDto = z.infer<typeof updateTdsRuleSchema>;

// There was a createBankSchema/updateBankSchema here (branch/ifsc/
// accountNumber, all optional) but it was never imported by any
// controller — Bank is a SIMPLE_MASTERS entry using the generic
// createMasterSchema (see masters.module.ts), and none of those three
// fields exist on the Bank Prisma model at all (which has only
// `ifscPrefix`, not `ifsc`, and no `branch`/`accountNumber` columns).
// Removed rather than fixed in place: it described a schema that never
// matched reality, and its presence is what led a later admin-UI fix to
// wire up fields the live API rejects with "Unrecognized key(s)" — see
// docs/todo.md's "AreaLocation/Bank/ChargeType have real optional
// columns the API never exposes" for the actual (deferred) gap and the
// real column name.

// createLetterTemplateSchema/updateLetterTemplateSchema live in documents.ts
// now, not here — this file's original version was itself incomplete
// (subject optional/wrong max length, entityType missing entirely, no
// merge-field validation) and was never wired to any controller; that's
// WHY LetterTemplate ended up routed through the generic master factory
// instead, which doesn't know about subject/body/entityType at all. See
// documents.ts and masters/letter-template/ for the real implementation.
