import { describe, it, expect } from 'vitest';
import { updateCompanyConfigSchema } from '../src/company.dto';

describe('updateCompanyConfigSchema — GST identity fields', () => {
  it('accepts a well-formed GSTIN and 2-digit state code', () => {
    const result = updateCompanyConfigSchema.safeParse({
      companyGstin: '09ABCDE1234F1Z5',
      gstStateCode: '09',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a malformed GSTIN (wrong length, lowercase, bad structure)', () => {
    expect(updateCompanyConfigSchema.safeParse({ companyGstin: 'not-a-gstin' }).success).toBe(false);
    expect(updateCompanyConfigSchema.safeParse({ companyGstin: '09abcde1234f1z5' }).success).toBe(false);
    expect(updateCompanyConfigSchema.safeParse({ companyGstin: '09ABCDE1234F1Z' }).success).toBe(false);
  });

  it('rejects a state code that is not exactly 2 digits', () => {
    expect(updateCompanyConfigSchema.safeParse({ gstStateCode: '9' }).success).toBe(false);
    expect(updateCompanyConfigSchema.safeParse({ gstStateCode: 'UP' }).success).toBe(false);
  });

  it('allows null to clear a previously-set value, same as logoUrl/primaryColorHex', () => {
    const result = updateCompanyConfigSchema.safeParse({ companyGstin: null, gstStateCode: null });
    expect(result.success).toBe(true);
  });
});
