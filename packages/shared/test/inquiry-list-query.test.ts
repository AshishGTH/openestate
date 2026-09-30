import { describe, expect, it } from 'vitest';
import { INQUIRY_SORT_FIELDS, inquiryListQuerySchema } from '../src/presales';

const parse = (q: Record<string, unknown>) => inquiryListQuerySchema.safeParse(q);

describe('inquiryListQuerySchema', () => {
  it('defaults preserve the endpoint\'s existing behaviour when nothing is sent', () => {
    expect(parse({})).toMatchObject({ success: true, data: { page: 1, limit: 20, sortOrder: 'asc' } });
    expect(parse({}).data!.status).toBeUndefined();
    expect(parse({}).data!.sortBy).toBeUndefined();
  });

  describe('status', () => {
    it('accepts one value, a comma list, and repeated params', () => {
      expect(parse({ status: 'OPEN' }).data!.status).toEqual(['OPEN']);
      expect(parse({ status: 'OPEN,CONTINUED' }).data!.status).toEqual(['OPEN', 'CONTINUED']);
      expect(parse({ status: ['OPEN', 'DUMPED'] }).data!.status).toEqual(['OPEN', 'DUMPED']);
      expect(parse({ status: 'OPEN, SUCCESSFUL' }).data!.status).toEqual(['OPEN', 'SUCCESSFUL']);
    });
    it('de-duplicates', () => expect(parse({ status: 'OPEN,OPEN' }).data!.status).toEqual(['OPEN']));
    it('empty or blank means "not filtering", like omitting it', () => {
      for (const v of ['', ' ', ',', ' , ']) expect(parse({ status: v }).data!.status, JSON.stringify(v)).toBeUndefined();
    });
    it('only the real backend statuses are valid (case-sensitive, nothing invented)', () => {
      for (const v of ['BOGUS', 'open', 'Open', 'PENDING', 'OPEN,BOGUS', 'OPEN;DROP', '1']) expect(parse({ status: v }).success, v).toBe(false);
    });
  });

  describe('sortBy / sortOrder', () => {
    it('accepts exactly the whitelist', () => {
      for (const f of INQUIRY_SORT_FIELDS) expect(parse({ sortBy: f }).success, f).toBe(true);
      expect([...INQUIRY_SORT_FIELDS]).toEqual(['createdAt', 'updatedAt', 'nextFollowupAt', 'status']);
    });
    it('rejects anything else, including real columns, relations and injection attempts', () => {
      for (const f of ['id', 'passwordHash', 'applicant.name', 'applicant', 'assignedToId', 'name', 'createdat', 'createdAt;DROP TABLE x', '__proto__', '']) {
        expect(parse({ sortBy: f }).success, f).toBe(false);
      }
    });
    it('sortOrder is asc|desc only', () => {
      expect(parse({ sortOrder: 'desc' }).success).toBe(true);
      expect(parse({ sortOrder: 'DESC' }).success).toBe(false);
      expect(parse({ sortOrder: 'random' }).success).toBe(false);
    });
  });

  describe('pagination', () => {
    it('coerces numeric strings and enforces bounds', () => {
      expect(parse({ page: '3', limit: '50' }).data).toMatchObject({ page: 3, limit: 50 });
      for (const bad of [{ page: 0 }, { page: 'x' }, { page: 1.5 }, { limit: 0 }, { limit: 101 }, { limit: -1 }]) expect(parse(bad).success, JSON.stringify(bad)).toBe(false);
    });
  });

  it('search is bounded, and unknown parameters are ignored (existing callers keep working)', () => {
    expect(parse({ search: 'x'.repeat(255) }).success).toBe(true);
    expect(parse({ search: 'x'.repeat(256) }).success).toBe(false);
    const r = parse({ page: 1, cacheBuster: '123' });
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty('cacheBuster');
  });
});
