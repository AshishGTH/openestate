/**
 * GET /inquiries follow-up date, assignee and lastActivityAt behaviour
 * (API_GAPS G3 + G6), through the real HTTP pipeline.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { bootstrapApp, cleanupLeads, describeIfDb, ensurePermissions, loginStaff, makeLead, makeRole, makeUser, type Session } from './helpers/inquiry-list-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Prisma = any;
type Row = { id: string; status: string; nextFollowupAt: string | null; updatedAt: string; lastActivityAt: string; applicant: { name: string }; assignedTo: { id: string } | null };

describeIfDb('e2e GET /inquiries follow-up filters, assignee and lastActivityAt', () => {
  let app: INestApplication;
  let prisma: Prisma;
  let fx: CompanyFixture;
  let other: CompanyFixture;
  let manager: Session;
  let repS: Session;
  let noRead: Session;
  let admin: Session;
  let managerId: string;
  let subId: string;
  let strangerId: string;
  let otherCompanyUserId: string;
  const names = (r: request.Response) => (r.body.data as Row[]).map((x) => x.applicant.name).sort();
  const T0 = new Date('2026-10-01T00:00:00.000Z');
  const at = (h: number) => new Date(T0.getTime() + h * 3_600_000);
  const iso = (d: Date) => encodeURIComponent(d.toISOString());

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma: prisma } = makeClients());
    fx = await seedCompany(prisma);
    other = await seedCompany(prisma);
    const perms = await ensurePermissions(prisma);
    const reader = await makeRole(prisma, fx.companyId, 'fu-reader', [PERMISSIONS.PRESALES_INQUIRY_READ], perms);
    const wrong = await makeRole(prisma, fx.companyId, 'fu-wrong', [PERMISSIONS.PRESALES_FOLLOW_UP_READ], perms);
    const adminRole = await makeRole(prisma, fx.companyId, 'fu-admin', [PERMISSIONS.PRESALES_INQUIRY_READ, PERMISSIONS.ADMIN_TEAM_SCOPE_ALL], perms);
    const otherRole = await makeRole(prisma, other.companyId, 'fu-other-reader', [PERMISSIONS.PRESALES_INQUIRY_READ], perms);

    const mgr = await makeUser(prisma, fx.companyId, reader.id, 'FU Manager');
    const sub = await makeUser(prisma, fx.companyId, reader.id, 'FU Sub', { managerId: mgr.id });
    const stranger = await makeUser(prisma, fx.companyId, reader.id, 'FU Stranger');
    const noReadU = await makeUser(prisma, fx.companyId, wrong.id, 'FU NoRead');
    const adminU = await makeUser(prisma, fx.companyId, adminRole.id, 'FU Admin');
    const foreign = await makeUser(prisma, other.companyId, otherRole.id, 'FU Foreign');
    managerId = mgr.id; subId = sub.id; strangerId = stranger.id; otherCompanyUserId = foreign.id;

    const c = fx.companyId;
    // Manager's own leads
    await makeLead(prisma, { companyId: c, assignedToId: mgr.id, name: 'M early', phone: '7100000001', nextFollowupAt: at(1), status: 'OPEN' });
    await makeLead(prisma, { companyId: c, assignedToId: mgr.id, name: 'M exactly-after', phone: '7100000002', nextFollowupAt: at(2), status: 'CONTINUED' });
    await makeLead(prisma, { companyId: c, assignedToId: mgr.id, name: 'M mid', phone: '7100000003', nextFollowupAt: at(5), status: 'OPEN' });
    await makeLead(prisma, { companyId: c, assignedToId: mgr.id, name: 'M exactly-before', phone: '7100000004', nextFollowupAt: at(10), status: 'OPEN' });
    await makeLead(prisma, { companyId: c, assignedToId: mgr.id, name: 'M none', phone: '7100000005', nextFollowupAt: null, status: 'OPEN' });
    await makeLead(prisma, { companyId: c, assignedToId: mgr.id, name: 'M none won', phone: '7100000006', nextFollowupAt: null, status: 'SUCCESSFUL' });
    // Subordinate's lead
    await makeLead(prisma, { companyId: c, assignedToId: sub.id, name: 'S lead', phone: '7100000007', nextFollowupAt: at(6), status: 'OPEN' });
    // A stranger's (outside the manager's subtree) and another company's
    await makeLead(prisma, { companyId: c, assignedToId: stranger.id, name: 'X stranger', phone: '7100000008', nextFollowupAt: at(6), status: 'OPEN' });
    await makeLead(prisma, { companyId: other.companyId, assignedToId: foreign.id, name: 'F foreign', phone: '7100000009', nextFollowupAt: at(6), status: 'OPEN' });

    manager = await loginStaff(app, mgr.email);
    repS = await loginStaff(app, sub.email);
    noRead = await loginStaff(app, noReadU.email);
    admin = await loginStaff(app, adminU.email);
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
      await request(app.getHttpServer()).get(`/api/v1/inquiries?followUpBefore=${iso(at(9))}`).expect(401);
    });
    it('a role without presales.inquiry.read -> 403', async () => {
      await noRead.get(`/inquiries?followUpBefore=${iso(at(9))}&assignedTo=me`).expect(403);
    });
    it('the manager sees own + subordinate, never a stranger or another company', async () => {
      expect(names(await manager.get('/inquiries?limit=100').expect(200))).toEqual(['M early', 'M exactly-after', 'M exactly-before', 'M mid', 'M none', 'M none won', 'S lead']);
    });
  });

  describe('followUpAfter / followUpBefore', () => {
    it('after is INCLUSIVE, before is EXCLUSIVE, and leads without a follow-up are never returned', async () => {
      const res = await manager.get(`/inquiries?followUpAfter=${iso(at(2))}&followUpBefore=${iso(at(10))}&limit=100`).expect(200);
      expect(names(res)).toEqual(['M exactly-after', 'M mid', 'S lead']); // at(2) in, at(10) out, nulls out
    });
    it('only a lower bound', async () => {
      expect(names(await manager.get(`/inquiries?followUpAfter=${iso(at(6))}&limit=100`).expect(200))).toEqual(['M exactly-before', 'S lead']);
    });
    it('only an upper bound ("overdue"-style)', async () => {
      expect(names(await manager.get(`/inquiries?followUpBefore=${iso(at(2))}&limit=100`).expect(200))).toEqual(['M early']);
    });
    it('offsets are honoured: the same instant expressed in IST selects the same lead', async () => {
      // at(5) = 05:00Z = 10:30+05:30
      const ist = encodeURIComponent('2026-10-01T10:30:00+05:30');
      expect(names(await manager.get(`/inquiries?followUpAfter=${ist}&followUpBefore=${iso(at(5.001))}&limit=100`).expect(200))).toEqual(['M mid']);
    });
    it('combines with status, sort and pagination', async () => {
      const res = await manager.get(`/inquiries?followUpAfter=${iso(at(0))}&followUpBefore=${iso(at(11))}&status=OPEN&sortBy=nextFollowupAt&sortOrder=asc&limit=2&page=1`).expect(200);
      expect(res.body.meta).toMatchObject({ total: 4, totalPages: 2 });
      expect((res.body.data as Row[]).map((r) => r.applicant.name)).toEqual(['M early', 'M mid']);
      const p2 = await manager.get(`/inquiries?followUpAfter=${iso(at(0))}&followUpBefore=${iso(at(11))}&status=OPEN&sortBy=nextFollowupAt&sortOrder=asc&limit=2&page=2`).expect(200);
      expect((p2.body.data as Row[]).map((r) => r.applicant.name)).toEqual(['S lead', 'M exactly-before']);
      expect((await manager.get(`/inquiries?followUpAfter=${iso(at(0))}&status=OPEN&limit=2&page=9`).expect(200)).body.data).toEqual([]);
    });
  });

  describe('followUp=none', () => {
    it('returns only leads with no follow-up date', async () => {
      expect(names(await manager.get('/inquiries?followUp=none&limit=100').expect(200))).toEqual(['M none', 'M none won']);
    });
    it('combines with status', async () => {
      expect(names(await manager.get('/inquiries?followUp=none&status=OPEN').expect(200))).toEqual(['M none']);
    });
  });

  describe('validation', () => {
    it('rejects date-only, offset-less, junk and numeric dates', async () => {
      for (const v of ['2026-10-01', '2026-10-01T00:00:00', 'tomorrow', '1727740800000', '2026-13-40T00:00:00Z']) {
        await manager.get(`/inquiries?followUpAfter=${encodeURIComponent(v)}`).expect(400);
        await manager.get(`/inquiries?followUpBefore=${encodeURIComponent(v)}`).expect(400);
      }
    });
    it('rejects an empty or reversed range, and none combined with a bound', async () => {
      await manager.get(`/inquiries?followUpAfter=${iso(at(5))}&followUpBefore=${iso(at(5))}`).expect(400);
      await manager.get(`/inquiries?followUpAfter=${iso(at(6))}&followUpBefore=${iso(at(5))}`).expect(400);
      await manager.get(`/inquiries?followUp=none&followUpBefore=${iso(at(5))}`).expect(400);
    });
    it('rejects an unknown followUp value', async () => {
      await manager.get('/inquiries?followUp=any').expect(400);
    });
    it('rejects malformed assignedTo', async () => {
      for (const v of ['ME', 'everyone', '123', 'me,you']) await manager.get(`/inquiries?assignedTo=${v}`).expect(400);
    });
  });

  describe('assignedTo', () => {
    it('me = only the caller\'s own leads (not the subordinate\'s)', async () => {
      expect(names(await manager.get('/inquiries?assignedTo=me&limit=100').expect(200))).toEqual(['M early', 'M exactly-after', 'M exactly-before', 'M mid', 'M none', 'M none won']);
    });
    it('a subordinate id narrows to that person; a manager may look at their report', async () => {
      expect(names(await manager.get(`/inquiries?assignedTo=${subId}&limit=100`).expect(200))).toEqual(['S lead']);
    });
    it('a user OUTSIDE the caller\'s team is a 404, even though they exist in the company', async () => {
      await manager.get(`/inquiries?assignedTo=${strangerId}`).expect(404);
      await repS.get(`/inquiries?assignedTo=${managerId}`).expect(404); // a subordinate cannot look upward
    });
    it('an unknown id and another company\'s user are a 404 (no probing)', async () => {
      await manager.get('/inquiries?assignedTo=00000000-0000-4000-8000-000000000000').expect(404);
      await admin.get(`/inquiries?assignedTo=${otherCompanyUserId}`).expect(404);
    });
    it('a company-wide role may filter to anyone in the company', async () => {
      expect(names(await admin.get(`/inquiries?assignedTo=${strangerId}`).expect(200))).toEqual(['X stranger']);
    });
    it('assignedTo=me for a caller with no leads is an empty page, not an error', async () => {
      const res = await admin.get('/inquiries?assignedTo=me').expect(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.total).toBe(0);
    });
  });

  describe('lastActivityAt', () => {
    it('is the lead\'s updatedAt when nothing was logged, and the newest logged interaction when that is later', async () => {
      const lead = (await manager.get('/inquiries?search=M%20mid').expect(200)).body.data[0] as Row;
      expect(lead.lastActivityAt).toBe(lead.updatedAt);

      // Backdate the lead, then log interactions after that but before now.
      const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
      await prisma.inquiry.update({ where: { id: lead.id }, data: { updatedAt: tenDaysAgo } });
      const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);
      const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
      await prisma.followUp.create({ data: { companyId: fx.companyId, inquiryId: lead.id, interactionAt: fiveDaysAgo, createdById: managerId } });
      await prisma.followUp.create({ data: { companyId: fx.companyId, inquiryId: lead.id, interactionAt: threeDaysAgo, createdById: managerId } });

      const after = (await manager.get('/inquiries?search=M%20mid').expect(200)).body.data[0] as Row;
      expect(after.updatedAt).toBe(tenDaysAgo.toISOString());
      expect(after.lastActivityAt).toBe(threeDaysAgo.toISOString());
    });
    it('ignores an interaction dated in the future', async () => {
      const lead = (await manager.get('/inquiries?search=M%20early').expect(200)).body.data[0] as Row;
      await prisma.inquiry.update({ where: { id: lead.id }, data: { updatedAt: new Date(Date.now() - 4 * 86_400_000) } });
      await prisma.followUp.create({ data: { companyId: fx.companyId, inquiryId: lead.id, interactionAt: new Date(Date.now() + 30 * 86_400_000), createdById: managerId } });
      const after = (await manager.get('/inquiries?search=M%20early').expect(200)).body.data[0] as Row;
      expect(after.lastActivityAt).toBe(after.updatedAt); // the future-dated interaction did not count
    });
    it('is present on the detail response too', async () => {
      const lead = (await manager.get('/inquiries?search=M%20mid').expect(200)).body.data[0] as Row;
      const detail = await manager.get(`/inquiries/${lead.id}`).expect(200);
      expect(detail.body.lastActivityAt).toBe(lead.lastActivityAt);
    });
  });
});
