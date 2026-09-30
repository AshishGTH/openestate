import { describe, it, expect } from 'vitest';
import { siteVisitListQuerySchema } from '../src/presales';

const parse = (q: object) => siteVisitListQuerySchema.safeParse(q);

describe('siteVisitListQuerySchema', () => {
  it('defaults', () => {
    const r = parse({});
    expect(r.success && r.data).toMatchObject({ page: 1, limit: 20, sortOrder: 'asc' });
  });
  it('accepts instants with an offset and parses them to Dates', () => {
    const r = parse({ from: '2026-10-01T00:00:00+05:30', to: '2026-10-02T00:00:00Z' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.from?.toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });
  it.each([{ from: '2026-10-01' }, { from: '2026-10-01T00:00:00' }, { to: 'tomorrow' }, { state: 'cancelled' }, { state: 'SCHEDULED' }, { assignedTo: 'all' }, { limit: '101' }, { page: '0' }])('rejects %o', (q) => {
    expect(parse(q).success).toBe(false);
  });
  it('rejects to <= from', () => {
    expect(parse({ from: '2026-10-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }).success).toBe(false);
  });
  it.each(['scheduled', 'awaiting_outcome', 'outcome_recorded'])('accepts state=%s', (state) => {
    expect(parse({ state }).success).toBe(true);
  });
});

import { inquiryActivityQuerySchema } from '../src/presales';

describe('inquiryActivityQuerySchema', () => {
  const ok = (q: object) => inquiryActivityQuerySchema.safeParse(q);
  it('defaults and empty type', () => {
    expect(ok({})).toMatchObject({ success: true, data: { page: 1, limit: 20 } });
    expect(ok({ type: '' })).toMatchObject({ success: true, data: { type: undefined } });
  });
  it('accepts a comma list and repeats, de-duplicated', () => {
    expect(ok({ type: 'follow_up,assignment' })).toMatchObject({ success: true, data: { type: ['follow_up', 'assignment'] } });
    expect(ok({ type: ['stage_change', 'stage_change', 'assignment'] })).toMatchObject({ success: true, data: { type: ['stage_change', 'assignment'] } });
  });
  it.each([{ type: 'communication' }, { type: 'call' }, { type: 'FOLLOW_UP' }, { page: '11' }, { page: '0' }, { limit: '101' }, { limit: '0' }])('rejects %o', (q) => {
    expect(ok(q).success).toBe(false);
  });
});
