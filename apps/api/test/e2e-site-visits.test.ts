/**
 * GET /site-visits (API_GAPS G5), through the real HTTP pipeline. A site visit
 * is a follow-up whose type is FLAGGED (follow_up_types.is_site_visit), never
 * one matched by name, scheduled on a lead in the caller's visible team.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { bootstrapApp, cleanupLeads, describeIfDb, ensurePermissions, loginStaff, makeLead, makeRole, makeUser, type Session } from './helpers/inquiry-list-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Prisma = any;

describeIfDb('e2e GET /site-visits', () => {
  let app: INestApplication;
  let prisma: Prisma;
  let fx: CompanyFixture;
  let other: CompanyFixture;
  let mgr: Session;
  let noRead: Session;
  let subId: string;
  let strangerId: string;
  const h = 3_600_000;
  const at = (ms: number) => new Date(Date.now() + ms);

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma: prisma } = makeClients());
    fx = await seedCompany(prisma);
    other = await seedCompany(prisma);
    const perms = await ensurePermissions(prisma);
    const reader = await makeRole(prisma, fx.companyId, 'sv-reader', [PERMISSIONS.PRESALES_SITE_VISIT_READ], perms);
    const wrong = await makeRole(prisma, fx.companyId, 'sv-wrong', [PERMISSIONS.PRESALES_FOLLOW_UP_READ, PERMISSIONS.PRESALES_INQUIRY_READ], perms);
    const otherRole = await makeRole(prisma, other.companyId, 'sv-other', [PERMISSIONS.PRESALES_SITE_VISIT_READ], perms);
    const m = await makeUser(prisma, fx.companyId, reader.id, 'SV Manager');
    const s = await makeUser(prisma, fx.companyId, reader.id, 'SV Sub', { managerId: m.id });
    const x = await makeUser(prisma, fx.companyId, reader.id, 'SV Stranger');
    const nr = await makeUser(prisma, fx.companyId, wrong.id, 'SV NoRead');
    const foreign = await makeUser(prisma, other.companyId, otherRole.id, 'SV Foreign');
    subId = s.id; strangerId = x.id;

    const c = fx.companyId;
    // The flag decides, not the name: "Walkthrough" is flagged, a type NAMED "Site Visit" is not.
    const flagged = await prisma.followUpType.create({ data: { companyId: c, name: 'Walkthrough', isSiteVisit: true } });
    const decoy = await prisma.followUpType.create({ data: { companyId: c, name: 'Site Visit', isSiteVisit: false } });
    const otherFlagged = await prisma.followUpType.create({ data: { companyId: other.companyId, name: 'Walkthrough', isSiteVisit: true } });

    let n = 0;
    const visit = async (o: { by: string; when: number | null; type?: string; outcome?: string | null; company?: string; venue?: string }) => {
      const company = o.company ?? c;
      const { inquiryId } = await makeLead(prisma, { companyId: company, assignedToId: o.by, name: `SV ${n}`, phone: `75000000${String(n++).padStart(2, '0')}` });
      await prisma.followUp.create({
        data: { companyId: company, inquiryId, typeId: o.type ?? flagged.id, scheduledAt: o.when == null ? null : at(o.when), outcome: o.outcome ?? null, venue: o.venue ?? 'Site office' },
      });
    };
    await visit({ by: m.id, when: 2 * h, venue: 'A' });          // scheduled (soon)
    await visit({ by: m.id, when: 30 * h, venue: 'B' });         // scheduled (later)
    await visit({ by: m.id, when: -3 * h });                     // awaiting outcome
    await visit({ by: m.id, when: -26 * h, outcome: 'COMPLETED' }); // outcome recorded
    await visit({ by: s.id, when: 5 * h });                      // subordinate, scheduled
    await visit({ by: m.id, when: 4 * h, type: decoy.id });      // named "Site Visit" but not flagged: excluded
    await visit({ by: m.id, when: null });                       // flagged type, no schedule: excluded
    await visit({ by: x.id, when: 3 * h });                      // stranger's lead: excluded
    await visit({ by: foreign.id, when: 3 * h, type: otherFlagged.id, company: other.companyId }); // other company: excluded

    mgr = await loginStaff(app, m.email);
    noRead = await loginStaff(app, nr.email);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    for (const f of [fx, other]) {
      await cleanupLeads(prisma, f.companyId);
      await prisma.followUpType.deleteMany({ where: { companyId: f.companyId } });
      await cleanupCompany(prisma, f.companyId);
    }
  });

  const list = (q = '') => mgr.get(`/site-visits${q}`).expect(200).then((r) => r.body);

  describe('authentication and authorization', () => {
    it('no token -> 401', async () => {
      await request(app.getHttpServer()).get('/api/v1/site-visits').expect(401);
    });
    it('a role without presales.site-visit.read -> 403 (even with follow-up and inquiry read)', async () => {
      await noRead.get('/site-visits').expect(403);
    });
  });

  describe('what counts as a site visit', () => {
    it('returns flagged, scheduled visits in the visible team only, soonest first', async () => {
      const r = await list();
      expect(r.meta).toEqual({ page: 1, limit: 20, total: 5, totalPages: 1 });
      const times = r.data.map((v: { scheduledAt: string }) => new Date(v.scheduledAt).getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(r.data.every((v: { type: { name: string } }) => v.type.name === 'Walkthrough')).toBe(true);
    });
    it('carries the lead, customer, project and assignee context the app shows', async () => {
      const r = await list('?state=scheduled&limit=1');
      const v = r.data[0];
      expect(v.inquiry.applicant).toEqual(expect.objectContaining({ name: expect.any(String), primaryPhone: expect.any(String) }));
      expect(v.inquiry.assignedTo).toEqual(expect.objectContaining({ name: expect.any(String) }));
      expect(v.inquiry.status).toBeDefined();
      expect(JSON.stringify(r)).not.toMatch(/passwordHash|totpSecret|recoveryCodes/);
    });
  });

  describe('state', () => {
    it('scheduled / awaiting_outcome / outcome_recorded partition the set', async () => {
      const sched = await list('?state=scheduled');
      const wait = await list('?state=awaiting_outcome');
      const done = await list('?state=outcome_recorded');
      expect([sched.meta.total, wait.meta.total, done.meta.total]).toEqual([3, 1, 1]);
      expect(sched.data.every((v: { state: string }) => v.state === 'scheduled')).toBe(true);
      expect(wait.data[0].state).toBe('awaiting_outcome');
      expect(done.data[0].outcome).toBe('COMPLETED');
    });
    it('an unknown state is 400 (there is no "cancelled")', async () => {
      await mgr.get('/site-visits?state=cancelled').expect(400);
    });
  });

  describe('date range', () => {
    it('from/to bound scheduledAt and combine with state', async () => {
      const from = encodeURIComponent(at(0).toISOString());
      const to = encodeURIComponent(at(6 * h).toISOString());
      const r = await list(`?from=${from}&to=${to}`);
      expect(r.meta.total).toBe(2); // +2h and the subordinate's +5h; +30h is out
      const s = await list(`?from=${from}&to=${to}&state=scheduled`);
      expect(s.meta.total).toBe(2);
      // the state bound must not overwrite the range: an awaiting-outcome visit is before "from"
      const w = await list(`?from=${from}&to=${to}&state=awaiting_outcome`);
      expect(w.meta.total).toBe(0);
    });
    it.each(['from=2026-10-01', 'from=2026-10-01T00:00:00', 'to=yesterday', 'from=1727740800000'])('%s is 400', async (q) => {
      await mgr.get(`/site-visits?${q}`).expect(400);
    });
    it('to not after from is 400', async () => {
      const t = encodeURIComponent(at(0).toISOString());
      await mgr.get(`/site-visits?from=${t}&to=${t}`).expect(400);
    });
  });

  describe('assignedTo', () => {
    it('me / a subordinate narrows; a stranger is 404; junk is 400', async () => {
      expect((await list('?assignedTo=me')).meta.total).toBe(4);
      expect((await list(`?assignedTo=${subId}`)).meta.total).toBe(1);
      await mgr.get(`/site-visits?assignedTo=${strangerId}`).expect(404);
      await mgr.get('/site-visits?assignedTo=all').expect(400);
    });
  });

  describe('pagination and order', () => {
    it('first page, next page, past the end', async () => {
      const p1 = await list('?limit=2');
      expect(p1.data).toHaveLength(2);
      expect(p1.meta).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });
      const p3 = await list('?limit=2&page=3');
      expect(p3.data).toHaveLength(1);
      const p9 = await list('?limit=2&page=9');
      expect(p9.data).toEqual([]);
      expect(p9.meta.total).toBe(5);
      const ids = [...p1.data, ...(await list('?limit=2&page=2')).data, ...p3.data].map((v: { id: string }) => v.id);
      expect(new Set(ids).size).toBe(5);
    });
    it('sortOrder=desc reverses', async () => {
      const r = await list('?sortOrder=desc');
      const times = r.data.map((v: { scheduledAt: string }) => new Date(v.scheduledAt).getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });
    it.each(['page=0', 'limit=0', 'limit=101', 'sortOrder=sideways'])('%s is 400', async (q) => {
      await mgr.get(`/site-visits?${q}`).expect(400);
    });
  });
});
