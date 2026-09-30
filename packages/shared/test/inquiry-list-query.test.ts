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

describe('follow-up and assignee parameters', () => {
  const uuid = '3b1c7d1e-5a53-4f2a-9f0e-0d0f9b0c1a11';
  it('accepts instants with an offset and turns them into Dates', () => {
    const r = parse({ followUpAfter: '2026-09-30T00:00:00+05:30', followUpBefore: '2026-10-01T00:00:00Z' });
    expect(r.success).toBe(true);
    expect(r.data!.followUpAfter).toEqual(new Date('2026-09-29T18:30:00Z'));
    expect(r.data!.followUpBefore).toEqual(new Date('2026-10-01T00:00:00Z'));
  });
  it('rejects date-only, offset-less and junk dates (they would be silently read as UTC)', () => {
    for (const v of ['2026-10-01', '2026-10-01T00:00:00', '2026-13-01T00:00:00Z', 'tomorrow', '1727740800000', '']) {
      expect(parse({ followUpAfter: v }).success, v).toBe(false);
    }
  });
  it('the range must be non-empty', () => {
    expect(parse({ followUpAfter: '2026-10-01T00:00:00Z', followUpBefore: '2026-10-01T00:00:00Z' }).success).toBe(false);
    expect(parse({ followUpAfter: '2026-10-02T00:00:00Z', followUpBefore: '2026-10-01T00:00:00Z' }).success).toBe(false);
  });
  it('followUp=none is the only value, and cannot be combined with a date bound', () => {
    expect(parse({ followUp: 'none' }).success).toBe(true);
    expect(parse({ followUp: 'any' }).success).toBe(false);
    expect(parse({ followUp: 'none', followUpBefore: '2026-10-01T00:00:00Z' }).success).toBe(false);
  });
  it('assignedTo is "me" or a uuid, nothing else', () => {
    expect(parse({ assignedTo: 'me' }).success).toBe(true);
    expect(parse({ assignedTo: uuid }).success).toBe(true);
    for (const v of ['ME', 'everyone', '123', 'me,you', `${uuid}x`]) expect(parse({ assignedTo: v }).success, v).toBe(false);
  });
});

import { inquirySummaryQuerySchema } from '../src/presales';

describe('inquirySummaryQuerySchema', () => {
  const sp = (q: Record<string, unknown>) => inquirySummaryQuerySchema.safeParse(q);
  it('all optional', () => expect(sp({}).success).toBe(true));
  it('dayStart and dayEnd come as a pair', () => {
    expect(sp({ dayStart: '2026-09-30T00:00:00+05:30' }).success).toBe(false);
    expect(sp({ dayEnd: '2026-10-01T00:00:00+05:30' }).success).toBe(false);
    expect(sp({ dayStart: '2026-09-30T00:00:00+05:30', dayEnd: '2026-10-01T00:00:00+05:30' }).success).toBe(true);
  });
  it('a day must be positive and at most 26 hours', () => {
    expect(sp({ dayStart: '2026-10-01T00:00:00Z', dayEnd: '2026-10-01T00:00:00Z' }).success).toBe(false);
    expect(sp({ dayStart: '2026-10-01T00:00:00Z', dayEnd: '2026-10-02T02:00:00Z' }).success).toBe(true); // 26h
    expect(sp({ dayStart: '2026-10-01T00:00:00Z', dayEnd: '2026-10-02T03:00:00Z' }).success).toBe(false);
    expect(sp({ dayStart: '2026-10-01T00:00:00Z', dayEnd: '2026-11-01T00:00:00Z' }).success).toBe(false); // a month is not a day
  });
  it('rejects offset-less instants', () => {
    expect(sp({ since: '2026-09-23' }).success).toBe(false);
    expect(sp({ since: '2026-09-23T00:00:00Z' }).success).toBe(true);
  });
});
