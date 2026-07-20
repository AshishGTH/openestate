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
    effectiveTo: z.coerce.date().optional(),
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
    effectiveTo: z.coerce.date().optional(),
    description: z.string().max(255).optional(),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).default(0),
  })
  .strict();

export type CreateTdsRuleDto = z.infer<typeof createTdsRuleSchema>;

export const updateTdsRuleSchema = createTdsRuleSchema.partial().strict();
export type UpdateTdsRuleDto = z.infer<typeof updateTdsRuleSchema>;

export const createBankSchema = z
  .object({
    name: z.string().min(1).max(255),
    branch: z.string().max(255).optional(),
    ifsc: z
      .string()
      .max(11)
      .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code')
      .optional(),
    accountNumber: z.string().max(30).optional(),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).default(0),
  })
  .strict();

export type CreateBankDto = z.infer<typeof createBankSchema>;

export const updateBankSchema = createBankSchema.partial().strict();
export type UpdateBankDto = z.infer<typeof updateBankSchema>;

export const createLetterTemplateSchema = z
  .object({
    name: z.string().min(1).max(255),
    subject: z.string().max(255).optional(),
    body: z.string(),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).default(0),
  })
  .strict();

export type CreateLetterTemplateDto = z.infer<typeof createLetterTemplateSchema>;

export const updateLetterTemplateSchema = createLetterTemplateSchema
  .partial()
  .strict();
export type UpdateLetterTemplateDto = z.infer<
  typeof updateLetterTemplateSchema
>;
