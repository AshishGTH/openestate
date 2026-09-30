/**
 * GET /inquiries?search= (API_GAPS G1). `search` was accepted by the shared
 * pagination schema but never applied. Through the real HTTP pipeline:
 * authorization, validation, team scope, wildcard/injection safety,
 * pagination, and backward compatibility when `search` is omitted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { bootstrapApp, cleanupLeads, describeIfDb, ensurePermissions, loginStaff, makeLead, makeRole, makeUser, type Session } from './helpers/inquiry-list-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Prisma = any;

describeIfDb('e2e GET /inquiries?search=', () => {
  let app: INestApplication;
  let prisma: Prisma;
  let fx: CompanyFixture;
  let other: CompanyFixture;
  let rep: Session;
  let noRead: Session;
  let admin: Session;
  let repId: string;
  let otherRepId: string;
  const names = (res: request.Response) => (res.body.data as Array<{ applicant: { name: string } }>).map((i) => i.applicant.name).sort();

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma: prisma } = makeClients());
    fx = await seedCompany(prisma);
    other = await seedCompany(prisma);
    const perms = await ensurePermissions(prisma);

    const reader = await makeRole(prisma, fx.companyId, 'search-reader', [PERMISSIONS.PRESALES_INQUIRY_READ], perms);
    const wrong = await makeRole(prisma, fx.companyId, 'search-wrong-role', [PERMISSIONS.PRESALES_FOLLOW_UP_READ], perms);
    const adminRole = await makeRole(prisma, fx.companyId, 'search-admin', [PERMISSIONS.PRESALES_INQUIRY_READ, PERMISSIONS.ADMIN_TEAM_SCOPE_ALL], perms);

    const repU = await makeUser(prisma, fx.companyId, reader.id, 'Search Rep');
    const otherRepU = await makeUser(prisma, fx.companyId, reader.id, 'Other Rep');
    const noReadU = await makeUser(prisma, fx.companyId, wrong.id, 'No Read');
    const adminU = await makeUser(prisma, fx.companyId, adminRole.id, 'Search Admin');
    repId = repU.id;
    otherRepId = otherRepU.id;

    await prisma.project.update({ where: { id: fx.projectId }, data: { name: 'Green Woods Residency' } });
    const lakeview = await prisma.project.create({ data: { companyId: fx.companyId, name: 'Lakeview Towers', code: `LV-${Date.now()}`, areaLocationId: (await prisma.project.findUnique({ where: { id: fx.projectId } })).areaLocationId } });

    const c = fx.companyId;
    await makeLead(prisma, { companyId: c, assignedToId: repId, name: 'Rahul Sharma', phone: '9876543210', email: 'Rahul.Sharma@example.com', projectId: fx.projectId });
    await makeLead(prisma, { companyId: c, assignedToId: repId, name: 'Anita Verma', phone: '9123456789', email: 'anita@example.com', projectId: lakeview.id });
    await makeLead(prisma, { companyId: c, assignedToId: repId, name: 'Suresh Rao', phone: '9988776655' });
    await makeLead(prisma, { companyId: c, assignedToId: repId, name: 'Carol NRI', phone: '+1 415 555 0132' });
    for (let i = 1; i <= 30; i++) await makeLead(prisma, { companyId: c, assignedToId: repId, name: `Bulk Lead ${String(i).padStart(2, '0')}`, phone: `70000000${String(i).padStart(2, '0')}` });
    await makeLead(prisma, { companyId: c, assignedToId: repId, name: 'Under_score 100% Buyer', phone: '9333333333' });
    // Not the rep's: another rep in the same company, and another company entirely.
    await makeLead(prisma, { companyId: c, assignedToId: otherRepId, name: 'Rahul Outsider', phone: '9111111111' });
    await makeLead(prisma, { companyId: other.companyId, assignedToId: null, name: 'Rahul Otherco', phone: '9222222222' });

    rep = await loginStaff(app, repU.email);
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
      await request(app.getHttpServer()).get('/api/v1/inquiries?search=rahul').expect(401);
    });
    it('a role without presales.inquiry.read -> 403', async () => {
      await noRead.get('/inquiries?search=rahul').expect(403);
    });
    it('an authorised rep only ever sees their own visible set, search or not', async () => {
      expect(names(await rep.get('/inquiries?search=rahul').expect(200))).toEqual(['Rahul Sharma']);
    });
    it('a company-wide role (admin.team-scope.all) sees the whole company but never another company', async () => {
      expect(names(await admin.get('/inquiries?search=rahul').expect(200))).toEqual(['Rahul Outsider', 'Rahul Sharma']);
    });
  });

  describe('matching', () => {
    it('name, case-insensitive and partial', async () => {
      expect(names(await rep.get('/inquiries?search=ANITA').expect(200))).toEqual(['Anita Verma']);
      expect(names(await rep.get('/inquiries?search=verm').expect(200))).toEqual(['Anita Verma']);
    });
    it('email, case-insensitive (stored mixed case)', async () => {
      expect(names(await rep.get('/inquiries?search=RAHUL.SHARMA@EXAMPLE').expect(200))).toEqual(['Rahul Sharma']);
    });
    it('project name', async () => {
      expect(names(await rep.get('/inquiries?search=lakeview').expect(200))).toEqual(['Anita Verma']);
    });
    it('phone digits: full, partial, spaced, and with +91 / 0 prefix all find the normalised number', async () => {
      for (const q of ['9876543210', '98765', '98765 43210', '%2B91%2098765%2043210', '098765%2043210']) {
        expect(names(await rep.get(`/inquiries?search=${q}`).expect(200)), q).toEqual(['Rahul Sharma']);
      }
    });
    it('a non-Indian number stored as typed is still found', async () => {
      expect(names(await rep.get('/inquiries?search=415%20555').expect(200))).toEqual(['Carol NRI']);
    });
    it('no match -> empty page with correct meta, not an error', async () => {
      const res = await rep.get('/inquiries?search=nobodyhasthisname').expect(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta).toMatchObject({ page: 1, total: 0, totalPages: 0 });
    });
  });

  describe('safety', () => {
    it('SQL wildcards are literal: "%%" and "_" do not match everything', async () => {
      for (const q of ['%25%25', '__', 'B_lk', 'Bul%25k']) {
        const res = await rep.get(`/inquiries?search=${q}`).expect(200);
        expect(res.body.meta.total, q).toBe(0);
      }
    });
    it('a name that really contains _ or % is found by typing it', async () => {
      expect(names(await rep.get('/inquiries?search=' + encodeURIComponent('score 100%')).expect(200))).toEqual(['Under_score 100% Buyer']);
      expect(names(await rep.get('/inquiries?search=' + encodeURIComponent('Under_score')).expect(200))).toEqual(['Under_score 100% Buyer']);
    });
    it('an injection attempt is inert and the table is intact afterwards', async () => {
      const res = await rep.get(`/inquiries?search=${encodeURIComponent("'; DROP TABLE inquiries;--")}`).expect(200);
      expect(res.body.meta.total).toBe(0);
      expect((await rep.get('/inquiries').expect(200)).body.meta.total).toBe(35);
    });
  });

  describe('validation', () => {
    it('rejects a search longer than 255 characters', async () => {
      await rep.get(`/inquiries?search=${'x'.repeat(256)}`).expect(400);
    });
    it('rejects bad pagination alongside a search', async () => {
      for (const q of ['page=0', 'page=abc', 'limit=0', 'limit=101', 'limit=-5']) await rep.get(`/inquiries?search=rahul&${q}`).expect(400);
    });
    it('ignores a search that is too short or blank (returns the unfiltered list)', async () => {
      for (const q of ['a', '%20%20%20', '']) expect((await rep.get(`/inquiries?search=${q}&limit=1`).expect(200)).body.meta.total, `"${q}"`).toBe(35);
    });
  });

  describe('pagination', () => {
    it('pages through a search: first page, next page, last page, past the end', async () => {
      const p1 = await rep.get('/inquiries?search=bulk&limit=12&page=1&sortBy=createdAt&sortOrder=asc').expect(200);
      expect(p1.body.data).toHaveLength(12);
      expect(p1.body.meta).toMatchObject({ page: 1, limit: 12, total: 30, totalPages: 3 });
      const p2 = await rep.get('/inquiries?search=bulk&limit=12&page=2&sortBy=createdAt&sortOrder=asc').expect(200);
      const p3 = await rep.get('/inquiries?search=bulk&limit=12&page=3&sortBy=createdAt&sortOrder=asc').expect(200);
      expect(p3.body.data).toHaveLength(6);
      const ids = [...p1.body.data, ...p2.body.data, ...p3.body.data].map((i: { id: string }) => i.id);
      expect(new Set(ids).size).toBe(30); // no duplicates, none missed
      const p4 = await rep.get('/inquiries?search=bulk&limit=12&page=4').expect(200);
      expect(p4.body.data).toEqual([]);
      expect(p4.body.meta).toMatchObject({ page: 4, total: 30, totalPages: 3 });
    });
  });

  describe('backward compatibility', () => {
    it('without search the endpoint behaves as before (whole visible set, newest first)', async () => {
      const res = await rep.get('/inquiries?limit=100').expect(200);
      expect(res.body.meta.total).toBe(35);
      const dates = (res.body.data as Array<{ createdAt: string }>).map((i) => i.createdAt);
      expect([...dates].sort().reverse()).toEqual(dates);
    });
    it('the response shape is unchanged and still never leaks credential columns', async () => {
      const res = await rep.get('/inquiries?search=rahul').expect(200);
      const row = res.body.data[0];
      expect(Object.keys(res.body)).toEqual(['data', 'meta']);
      expect(row.applicant).not.toHaveProperty('panCiphertext');
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|totpSecret|recoveryCodes/);
    });
  });
});
