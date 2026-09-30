import { describe, expect, it } from 'vitest';
import { inquiryOrderBy } from '../src/presales/inquiry.service';

describe('inquiryOrderBy', () => {
  it('defaults to newest first with an id tie-break', () => {
    expect(inquiryOrderBy(undefined, 'asc')).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
    expect(inquiryOrderBy(undefined, 'desc')).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
  });
  it('sorts by the requested field, then id (stable pages)', () => {
    expect(inquiryOrderBy('updatedAt', 'desc')).toEqual([{ updatedAt: 'desc' }, { id: 'asc' }]);
    expect(inquiryOrderBy('status', 'asc')).toEqual([{ status: 'asc' }, { id: 'asc' }]);
  });
  it('follow-up date always puts leads with no follow-up last, in both directions', () => {
    expect(inquiryOrderBy('nextFollowupAt', 'asc')[0]).toEqual({ nextFollowupAt: { sort: 'asc', nulls: 'last' } });
    expect(inquiryOrderBy('nextFollowupAt', 'desc')[0]).toEqual({ nextFollowupAt: { sort: 'desc', nulls: 'last' } });
  });
});
