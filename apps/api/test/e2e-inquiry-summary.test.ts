/**
 * GET /inquiries/summary (API_GAPS G4), through the real HTTP pipeline. The key
 * property for a dashboard: the numbers agree EXACTLY with the list endpoint
 * for the same filters, and "today" is the company's day, not the server's.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS, dayBoundsInTimeZone } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { bootstrapApp, cleanupLeads, describeIfDb, ensurePermissions, loginStaff, makeLead, makeRole, makeUser, type Session } from './helpers/inquiry-list-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Prisma = any;

describeIfDb('e2e GET /inquiries/summary', () => {
  let app: INestApplication;
  let prisma: Prisma;
  let fx: CompanyFixture;
  let other: CompanyFixture;
  let mgr: Session;
  let noRead: Session;
  let strangerId: string;
  let subId: string;
  const h = 3_600_000;
  const day = 24 * h;
  const bounds = dayBoundsInTimeZone(new Date(), 'Asia/Kolkata');
  const iso = (d: Date) => encodeURIComponent(d.toISOString());
  const t = (ms: number) => new Date(ms);

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma: prisma } = makeClients());
    fx = await seedCompany(prisma);
    other = await seedCompany(prisma);
    const perms = await ensurePermissions(prisma);
    const reader = await makeRole(prisma, fx.companyId, 'sum-reader', [PERMISSIONS.PRESALES_INQUIRY_READ], perms);
    const wrong = await makeRole(prisma, fx.companyId, 'sum-wrong', [PERMISSIONS.PRESALES_FOLLOW_UP_READ], perms);
    const otherRole = await makeRole(prisma, other.companyId, 'sum-other', [PERMISSIONS.PRESALES_INQUIRY_READ], perms);
    const m = await makeUser(prisma, fx.companyId, reader.id, 'Sum Manager');
    const s = await makeUser(prisma, fx.companyId, reader.id, 'Sum Sub', { managerId: m.id });
    const x = await makeUser(prisma, fx.companyId, reader.id, 'Sum Stranger');
    const nr = await makeUser(prisma, fx.companyId, wrong.id, 'Sum NoRead');
    const foreign = await makeUser(prisma, other.companyId, otherRole.id, 'Sum Foreign');
    subId = s.id; strangerId = x.id;

    const c = fx.companyId;
    const start = bounds.start.getTime();
    const end = bounds.end.getTime();
    const now = Date.now();
    let n = 0;
    const lead = (o: { by: string; status?: 'OPEN' | 'CONTINUED' | 'SUCCESSFUL' | 'DUMPED'; due?: number | null; created?: number; company?: string }) =>
      makeLead(prisma, { companyId: o.company ?? c, assignedToId: o.by, name: `Sum ${n}`, phone: `76000000${String(n++).padStart(2, '0')}`, status: o.status ?? 'OPEN', nextFollowupAt: o.due == null ? null : t(o.due), createdAt: o.created == null ? undefined : t(o.created) });

    // Manager: 2 overdue, 2 due today, 1 tomorrow, 1 no follow-up (all active)
    await lead({ by: m.id, status: 'OPEN', due: start - h });
    await lead({ by: m.id, status: 'CONTINUED', due: start - 3 * day });
    await lead({ by: m.id, status: 'OPEN', due: start + h });
    await lead({ by: m.id, status: 'CONTINUED', due: end - h });
    await lead({ by: m.id, status: 'OPEN', due: end + h });
    await lead({ by: m.id, status: 'OPEN', due: null });
    // Not counted as overdue/due: closed leads with follow-up dates
    await lead({ by: m.id, status: 'SUCCESSFUL', due: start - h });
    await lead({ by: m.id, status: 'DUMPED', due: start + h });
    // Old lead (created 20 days ago): not "new"
    await lead({ by: m.id, status: 'OPEN', due: null, created: now - 20 * day });
    // Subordinate: 1 overdue, 1 due today
    await lead({ by: s.id, status: 'OPEN', due: start - 2 * h });
    await lead({ by: s.id, status: 'OPEN', due: start + 2 * h });
    // Stranger and another company: must never be counted
    await lead({ by: x.id, status: 'OPEN', due: start - h });
    await lead({ by: foreign.id, status: 'OPEN', due: start - h, company: other.companyId });

    mgr = await loginStaff(app, m.email);
    noRead = await loginStaff(app, nr.email);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    for (const f of [fx, other]) {
      await cleanupLeads(prisma, f.companyId);
      await cleanupCompany(prisma, f.companyId);
    }
    await prisma.$disconnect();
  });

  describe('authorization', () => {
    it('unauthenticated -> 401', async () => {
      await request(app.getHttpServer()).get('/api/v1/inquiries/summary').expect(401);
    });
    it('a role without presales.inquiry.read -> 403', async () => {
      await noRead.get('/inquiries/summary').expect(403);
    });
    it('/inquiries/summary is the summary, not an id lookup that fails uuid validation', async () => {
      await mgr.get('/inquiries/summary').expect(200);
    });
  });

  describe('numbers', () => {
    it('counts the manager\'s visible set (own + subordinate), never a stranger or another company', async () => {
      const r = (await mgr.get('/inquiries/summary').expect(200)).body;
      // manager: 9 leads, subordinate: 2  => 11 visible
      expect(r.total).toBe(11);
      expect(r.byStatus).toEqual({ OPEN: 7, CONTINUED: 2, SUCCESSFUL: 1, DUMPED: 1 });
      // overdue: manager 2 (OPEN -1h, CONTINUED -3d) + subordinate 1; the SUCCESSFUL one is excluded
      expect(r.overdue).toBe(3);
      // due today: manager 2 + subordinate 1; the DUMPED one is excluded
      expect(r.dueToday).toBe(3);
    });
    it('newSince defaults to the last 7 days: the 20-day-old lead is not new', async () => {
      const r = (await mgr.get('/inquiries/summary').expect(200)).body;
      expect(r.newSince).toBe(10); // all 11 except the one created 20 days ago
    });
    it('byStatus is zero-filled and total is the sum', async () => {
      const r = (await mgr.get(`/inquiries/summary?assignedTo=${subId}`).expect(200)).body;
      expect(r.byStatus).toEqual({ OPEN: 2, CONTINUED: 0, SUCCESSFUL: 0, DUMPED: 0 });
      expect(r.total).toBe(2);
    });
    it('assignedTo=me narrows to the caller\'s own leads', async () => {
      const r = (await mgr.get('/inquiries/summary?assignedTo=me').expect(200)).body;
      expect(r.total).toBe(9);
      expect(r.overdue).toBe(2);
      expect(r.dueToday).toBe(2);
    });
    it('a user outside the caller\'s team is a 404', async () => {
      await mgr.get(`/inquiries/summary?assignedTo=${strangerId}`).expect(404);
    });
  });

  describe('agrees exactly with the list endpoint', () => {
    it('overdue, dueToday, byStatus and total match the equivalent list queries', async () => {
      const s = (await mgr.get('/inquiries/summary').expect(200)).body;
      const { dayStart, dayEnd } = s.period as { dayStart: string; dayEnd: string };
      const total = (q: string) => mgr.get(`/inquiries?limit=1&${q}`).expect(200).then((r) => r.body.meta.total as number);
      expect(await total('')).toBe(s.total);
      expect(await total(`status=OPEN,CONTINUED&followUpBefore=${encodeURIComponent(dayStart)}`)).toBe(s.overdue);
      expect(await total(`status=OPEN,CONTINUED&followUpAfter=${encodeURIComponent(dayStart)}&followUpBefore=${encodeURIComponent(dayEnd)}`)).toBe(s.dueToday);
      for (const st of ['OPEN', 'CONTINUED', 'SUCCESSFUL', 'DUMPED']) expect(await total(`status=${st}`)).toBe(s.byStatus[st]);
    });
  });

  describe('date and time zone semantics', () => {
    it('defaults to the COMPANY day (Asia/Kolkata), reported back in period', async () => {
      const r = (await mgr.get('/inquiries/summary').expect(200)).body;
      expect(r.period.timeZone).toBe('Asia/Kolkata');
      expect(r.period.dayStart).toBe(bounds.start.toISOString());
      expect(r.period.dayEnd).toBe(bounds.end.toISOString());
      expect(new Date(r.period.since).getTime()).toBe(bounds.end.getTime() - 7 * day);
    });
    it('a client-supplied day overrides the company day, and period.timeZone is null', async () => {
      // Shift the "day" 2 hours later: the overdue lead at start-1h is still overdue, the one at start+1h now is too.
      const ds = new Date(bounds.start.getTime() + 2 * h);
      const de = new Date(bounds.end.getTime() + 2 * h);
      const r = (await mgr.get(`/inquiries/summary?dayStart=${iso(ds)}&dayEnd=${iso(de)}`).expect(200)).body;
      expect(r.period.timeZone).toBeNull();
      expect(r.overdue).toBeGreaterThan(3); // start+1h and start+2h leads have now slipped into "overdue"
    });
    it('offsets are honoured: the same day expressed in +05:30 gives identical results', async () => {
      const ist = (d: Date) => encodeURIComponent(new Date(d.getTime() + 5.5 * h).toISOString().replace('Z', '+05:30').replace(/\.\d+/, ''));
      const a = (await mgr.get('/inquiries/summary').expect(200)).body;
      const b = (await mgr.get(`/inquiries/summary?dayStart=${ist(bounds.start)}&dayEnd=${ist(bounds.end)}`).expect(200)).body;
      expect(b.overdue).toBe(a.overdue);
      expect(b.dueToday).toBe(a.dueToday);
    });
    it('an invalid company timezone setting falls back instead of failing the dashboard', async () => {
      await prisma.companyConfig.update({ where: { companyId: fx.companyId }, data: { timezone: 'Not/AZone' } });
      const r = (await mgr.get('/inquiries/summary').expect(200)).body;
      expect(r.period.timeZone).toBe('Asia/Kolkata');
      await prisma.companyConfig.update({ where: { companyId: fx.companyId }, data: { timezone: 'Asia/Kolkata' } });
    });
    it('since narrows "new"', async () => {
      const r = (await mgr.get(`/inquiries/summary?since=${iso(new Date(Date.now() + h))}`).expect(200)).body;
      expect(r.newSince).toBe(0);
    });
  });

  describe('validation', () => {
    it('dayStart and dayEnd must come together', async () => {
      await mgr.get(`/inquiries/summary?dayStart=${iso(bounds.start)}`).expect(400);
      await mgr.get(`/inquiries/summary?dayEnd=${iso(bounds.end)}`).expect(400);
    });
    it('rejects a reversed, empty or over-long day', async () => {
      await mgr.get(`/inquiries/summary?dayStart=${iso(bounds.end)}&dayEnd=${iso(bounds.start)}`).expect(400);
      await mgr.get(`/inquiries/summary?dayStart=${iso(bounds.start)}&dayEnd=${iso(bounds.start)}`).expect(400);
      await mgr.get(`/inquiries/summary?dayStart=${iso(bounds.start)}&dayEnd=${iso(new Date(bounds.start.getTime() + 3 * day))}`).expect(400);
    });
    it('rejects date-only, offset-less and junk instants', async () => {
      for (const v of ['2026-10-01', '2026-10-01T00:00:00', 'yesterday', '1727740800000']) await mgr.get(`/inquiries/summary?since=${encodeURIComponent(v)}`).expect(400);
    });
    it('rejects a malformed assignedTo', async () => {
      for (const v of ['ME', 'all', '123']) await mgr.get(`/inquiries/summary?assignedTo=${v}`).expect(400);
    });
  });
});
