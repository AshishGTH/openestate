import { describe, it, expect } from 'vitest';
import { totpVerifySchema } from '../src/auth.dto';

describe('totpVerifySchema', () => {
  it('accepts a 6-digit TOTP code and an XXXXX-XXXXX recovery code', () => {
    expect(totpVerifySchema.parse({ code: '123456' })).toEqual({ code: '123456' });
    expect(totpVerifySchema.parse({ code: 'FA897-AF930' })).toEqual({ code: 'FA897-AF930' });
  });

  // Stored recovery codes are uppercase hex; a phone keyboard or a copied
  // line with trailing whitespace shouldn't make a valid code unusable.
  it('trims and uppercases a recovery code before matching', () => {
    expect(totpVerifySchema.parse({ code: '  fa897-af930 ' })).toEqual({ code: 'FA897-AF930' });
    expect(totpVerifySchema.parse({ code: 'Fa897-aF930\n' })).toEqual({ code: 'FA897-AF930' });
  });

  it('rejects malformed codes, including a recovery code truncated to 6 characters', () => {
    for (const code of ['FA897-', '1234567', '12345', 'FA897AF930', 'GA897-AF930', 'FA897-AF93', '']) {
      expect(totpVerifySchema.safeParse({ code }).success, code).toBe(false);
    }
  });

  it('still rejects unknown keys', () => {
    expect(totpVerifySchema.safeParse({ code: '123456', extra: true }).success).toBe(false);
  });
});
