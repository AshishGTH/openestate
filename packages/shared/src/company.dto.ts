import { z } from 'zod';

export const updateCompanySchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type UpdateCompanyDto = z.infer<typeof updateCompanySchema>;

// Format only (2-digit state code + 10-char PAN + entity code + 'Z' +
// check digit) — the GSTIN check-digit is a mod-36 algorithm; deferred
// rather than risking a wrong implementation silently rejecting real
// GSTINs (worse than no check at all). See docs/todo.md.
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const updateCompanyConfigSchema = z
  .object({
    // Supplier-side GST identity (CompanyConfig.companyGstin/gstStateCode)
    // — read by BookingService's frozen CGST/SGST-vs-IGST split (Phase 4)
    // but had no way to be set outside the seed script until now.
    companyGstin: z.string().regex(GSTIN_REGEX, 'Invalid GSTIN format').nullable().optional(),
    gstStateCode: z.string().regex(/^[0-9]{2}$/, 'Must be a 2-digit state code').nullable().optional(),
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
