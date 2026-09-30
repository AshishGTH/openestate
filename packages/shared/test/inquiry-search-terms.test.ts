import { describe, expect, it } from 'vitest';
import { buildInquirySearchTerms } from '../src/presales';

describe('buildInquirySearchTerms', () => {
  it('ignores empty, whitespace-only and one-character input (unfiltered list)', () => {
    for (const raw of [undefined, null, '', '   ', 'a', ' a ']) expect(buildInquirySearchTerms(raw as never)).toBeNull();
  });

  it('trims and collapses whitespace in the text term', () => {
    expect(buildInquirySearchTerms('  Rahul    Sharma ')).toEqual({ text: 'Rahul Sharma', phoneDigits: [] });
  });

  it('a name is not phone-like even if it contains digits', () => {
    expect(buildInquirySearchTerms('Tower 12').phoneDigits).toEqual([]);
    expect(buildInquirySearchTerms('a1b2c3').phoneDigits).toEqual([]);
  });

  it('phone-like input yields digits, tolerating spaces, dashes and brackets', () => {
    expect(buildInquirySearchTerms('98765 43210')!.phoneDigits).toEqual(['9876543210']);
    expect(buildInquirySearchTerms('(98765) 432-10')!.phoneDigits).toEqual(['9876543210']);
  });

  it('needs at least 3 digits before it searches phone numbers', () => {
    expect(buildInquirySearchTerms('98')!.phoneDigits).toEqual([]);
    expect(buildInquirySearchTerms('987')!.phoneDigits).toEqual(['987']);
  });

  it('also tries the number without the +91 or leading 0 prefix normalizePhone strips', () => {
    expect(buildInquirySearchTerms('+91 98765 43210')!.phoneDigits).toEqual(['919876543210', '9876543210']);
    expect(buildInquirySearchTerms('098765 43210')!.phoneDigits).toEqual(['09876543210', '9876543210']);
    expect(buildInquirySearchTerms('91 98765')!.phoneDigits).toEqual(['9198765', '98765']);
  });

  it('a bare 91xxx is NOT stripped (it may be the start of a real number)', () => {
    expect(buildInquirySearchTerms('9198765')!.phoneDigits).toEqual(['9198765']);
  });

  it('keeps SQL and wildcard characters as literal text (they are only ever bound parameters)', () => {
    expect(buildInquirySearchTerms("'; DROP TABLE inquiries;--")!.text).toBe("'; DROP TABLE inquiries;--");
    expect(buildInquirySearchTerms('100%')!.text).toBe('100%');
  });
});

import { escapeLikePattern } from '../src/presales';

describe('escapeLikePattern', () => {
  it('escapes %, _ and the escape character so text matches literally', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
    expect(escapeLikePattern('%_\\')).toBe('\\%\\_\\\\');
  });
  it('leaves ordinary text alone', () => {
    expect(escapeLikePattern('Rahul Sharma')).toBe('Rahul Sharma');
  });
});
