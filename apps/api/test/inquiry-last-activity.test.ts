import { describe, expect, it, vi } from 'vitest';
import { InquiryService } from '../src/presales/inquiry.service';

// lastActivityAt must cost ONE query per page, however many rows: a per-row
// lookup would be an N+1 on the most frequently called endpoint in the app.
const NOW = new Date('2026-09-30T10:00:00Z');
const build = (groupBy: (args: unknown) => Promise<unknown[]>) =>
  new InquiryService(undefined as never, { followUp: { groupBy } } as never, { now: () => NOW } as never, undefined as never, undefined as never, undefined as never, undefined as never, undefined as never);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (svc: InquiryService, rows: unknown[]) => (svc as any).withLastActivity('company-1', rows);

describe('InquiryService.withLastActivity', () => {
  it('issues exactly one grouped query for a full page of 100 rows', async () => {
    const groupBy = vi.fn(async () => []);
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `i${i}`, updatedAt: new Date('2026-09-01T00:00:00Z') }));
    await run(build(groupBy), rows);
    expect(groupBy).toHaveBeenCalledTimes(1);
    const args = groupBy.mock.calls[0][0] as { by: string[]; where: Record<string, unknown> };
    expect(args.by).toEqual(['inquiryId']);
    expect(args.where).toMatchObject({ companyId: 'company-1', interactionAt: { lte: NOW } }); // company-scoped, future-dated ignored
    expect((args.where.inquiryId as { in: string[] }).in).toHaveLength(100);
  });
  it('issues no query for an empty page', async () => {
    const groupBy = vi.fn(async () => []);
    expect(await run(build(groupBy), [])).toEqual([]);
    expect(groupBy).not.toHaveBeenCalled();
  });
  it('takes the later of updatedAt and the newest interaction, per row', async () => {
    const groupBy = vi.fn(async () => [
      { inquiryId: 'newer', _max: { interactionAt: new Date('2026-09-20T00:00:00Z') } },
      { inquiryId: 'older', _max: { interactionAt: new Date('2026-08-01T00:00:00Z') } },
    ]);
    const updated = new Date('2026-09-10T00:00:00Z');
    const out = await run(build(groupBy), [
      { id: 'newer', updatedAt: updated },
      { id: 'older', updatedAt: updated },
      { id: 'none', updatedAt: updated },
    ]);
    expect(out.map((r: { lastActivityAt: Date }) => r.lastActivityAt.toISOString())).toEqual(['2026-09-20T00:00:00.000Z', '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z']);
  });
});
