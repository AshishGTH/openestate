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
