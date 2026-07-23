import { z } from 'zod';

export const updateCompanySchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type UpdateCompanyDto = z.infer<typeof updateCompanySchema>;

export const updateCompanyConfigSchema = z
  .object({
    labelOverrides: z
      .record(z.string().max(100), z.string().max(100))
      .optional(),
    enabledModules: z
      .array(z.enum(['presales', 'postsales', 'accounts', 'portal']))
      .optional(),
    currency: z.string().length(3).optional(),
    timezone: z.string().max(50).optional(),
    fyStartMonth: z.number().int().min(1).max(12).optional(),
    dateFormat: z.string().max(20).optional(),
    // Phase 6: portal branding (logo + accent color shown in apps/portal).
    // Nullable so staff can explicitly clear a previously-set value, not
    // just overwrite it with a new one.
    logoUrl: z.string().url().max(500).nullable().optional(),
    primaryColorHex: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a 6-digit hex color, e.g. #2563EB')
      .nullable()
      .optional(),
  })
  .strict();

export type UpdateCompanyConfigDto = z.infer<typeof updateCompanyConfigSchema>;

export const DEFAULT_LABEL_OVERRIDES: Record<string, string> = {
  unit: 'Unit',
  project: 'Project',
  tower: 'Tower',
  floor: 'Floor',
  booking: 'Booking',
  inquiry: 'Inquiry',
};
