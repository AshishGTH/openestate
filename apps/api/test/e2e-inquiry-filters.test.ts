/**
 * GET /inquiries?status=&sortBy=&sortOrder= (API_GAPS G2 and the sortBy
 * whitelist), through the real HTTP pipeline. Includes the combination the
 * mobile app uses: search + status + pagination.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { bootstrapApp, cleanupLeads, describeIfDb, ensurePermissions, loginStaff, makeLead, makeRole, makeUser, type Session } from './helpers/inquiry-list-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Prisma = any;
type Row = { id: string; status: string; nextFollowupAt: string | null; applicant: { name: string } };

describeIfDb('e2e GET /inquiries filters and sorting', () => {
  let app: INestApplication;
  let prisma: Prisma;
  let fx: CompanyFixture;
  let rep: Session;
  let noRead: Session;
  let editor: Session;
  const day = 86_400_000;
  const rows = (r: request.Response) => r.body.data as Row[];
  const ids = (r: request.Response) => rows(r).map((x) => x.id);

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma: prisma } = makeClients());
    fx = await seedCompany(prisma);
    const perms = await ensurePermissions(prisma);
    const reader = await makeRole(prisma, fx.companyId, 'filter-reader', [PERMISSIONS.PRESALES_INQUIRY_READ], perms);
    const wrong = await makeRole(prisma, fx.companyId, 'filter-wrong', [PERMISSIONS.PRESALES_FOLLOW_UP_READ], perms);
    const editorRole = await makeRole(prisma, fx.companyId, 'filter-editor', [PERMISSIONS.PRESALES_INQUIRY_READ, PERMISSIONS.PRESALES_INQUIRY_UPDATE, PERMISSIONS.PRESALES_INQUIRY_ASSIGN], perms);
    const editorU = await makeUser(prisma, fx.companyId, editorRole.id, 'Filter Editor');
    const repU = await makeUser(prisma, fx.companyId, reader.id, 'Filter Rep');
    const otherU = await makeUser(prisma, fx.companyId, reader.id, 'Filter Other');
    const noReadU = await makeUser(prisma, fx.companyId, wrong.id, 'Filter NoRead');

    const c = fx.companyId;
    const base = Date.now();
    // 12 OPEN (named Ashish ...), 6 CONTINUED, 4 SUCCESSFUL, 3 DUMPED, all the rep's.
    for (let i = 0; i < 12; i++) await makeLead(prisma, { companyId: c, assignedToId: repU.id, name: `Ashish Open ${String(i).padStart(2, '0')}`, phone: `71000000${String(i).padStart(2, '0')}`, status: 'OPEN', nextFollowupAt: i < 4 ? new Date(base + (i + 1) * day) : null, createdAt: new Date(base - i * 1000) });
    for (let i = 0; i < 6; i++) await makeLead(prisma, { companyId: c, assignedToId: repU.id, name: `Continued ${i}`, phone: `72000000${String(i).padStart(2, '0')}`, status: 'CONTINUED', nextFollowupAt: new Date(base - (i + 1) * day), createdAt: new Date(base - 20_000 - i * 1000) });
    for (let i = 0; i < 4; i++) await makeLead(prisma, { companyId: c, assignedToId: repU.id, name: `Won ${i}`, phone: `73000000${String(i).padStart(2, '0')}`, status: 'SUCCESSFUL', createdAt: new Date(base - 40_000 - i * 1000) });
    for (let i = 0; i < 3; i++) await makeLead(prisma, { companyId: c, assignedToId: repU.id, name: `Dropped ${i}`, phone: `74000000${String(i).padStart(2, '0')}`, status: 'DUMPED', createdAt: new Date(base - 60_000 - i * 1000) });
    // Someone else's OPEN lead that matches everything the rep searches for.
    await makeLead(prisma, { companyId: c, assignedToId: otherU.id, name: 'Ashish Outsider', phone: '7500000001', status: 'OPEN' });

    rep = await loginStaff(app, repU.email);
    noRead = await loginStaff(app, noReadU.email);
    editor = await loginStaff(app, editorU.email);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await cleanupLeads(prisma, fx.companyId);
    await cleanupCompany(prisma, fx.companyId);
    await prisma.$disconnect();
  });

  describe('authorization', () => {
    it('unauthenticated -> 401', async () => {
      await request(app.getHttpServer()).get('/api/v1/inquiries?status=OPEN').expect(401);
    });
    it('a role without presales.inquiry.read -> 403, even with valid filters', async () => {
      await noRead.get('/inquiries?status=OPEN&sortBy=createdAt').expect(403);
    });
    it('a filter never widens scope: the rep\'s OPEN leads exclude the other rep\'s', async () => {
      const res = await rep.get('/inquiries?status=OPEN&limit=100').expect(200);
      expect(res.body.meta.total).toBe(12);
      expect(rows(res).some((r) => r.applicant.name === 'Ashish Outsider')).toBe(false);
    });
  });

  describe('status', () => {
    it.each([['OPEN', 12], ['CONTINUED', 6], ['SUCCESSFUL', 4], ['DUMPED', 3]])('%s -> %i', async (s, n) => {
      const res = await rep.get(`/inquiries?status=${s}&limit=100`).expect(200);
      expect(res.body.meta.total).toBe(n);
      expect(rows(res).every((r) => r.status === s)).toBe(true);
    });
    it('a comma list is a union', async () => {
      expect((await rep.get('/inquiries?status=OPEN,CONTINUED&limit=100').expect(200)).body.meta.total).toBe(18);
    });
    it('repeated parameters are a union too', async () => {
      expect((await rep.get('/inquiries?status=SUCCESSFUL&status=DUMPED&limit=100').expect(200)).body.meta.total).toBe(7);
    });
    it('omitted or empty status returns everything visible, exactly as before', async () => {
      expect((await rep.get('/inquiries?limit=100').expect(200)).body.meta.total).toBe(25);
      expect((await rep.get('/inquiries?status=&limit=100').expect(200)).body.meta.total).toBe(25);
    });
    it('rejects unknown, mis-cased and mixed-invalid statuses with 400', async () => {
      for (const s of ['BOGUS', 'open', 'PENDING', 'OPEN,BOGUS', 'OPEN%3BDROP']) await rep.get(`/inquiries?status=${s}`).expect(400);
    });
  });

  describe('search + status + pagination together', () => {
    it('the mobile combination: search=ashish&status=OPEN&page&limit', async () => {
      const p1 = await rep.get('/inquiries?search=ashish&status=OPEN&page=1&limit=5').expect(200);
      expect(p1.body.meta).toMatchObject({ page: 1, limit: 5, total: 12, totalPages: 3 });
      expect(rows(p1)).toHaveLength(5);
      const p2 = await rep.get('/inquiries?search=ashish&status=OPEN&page=2&limit=5').expect(200);
      const p3 = await rep.get('/inquiries?search=ashish&status=OPEN&page=3&limit=5').expect(200);
      expect(rows(p3)).toHaveLength(2);
      const all = [...ids(p1), ...ids(p2), ...ids(p3)];
      expect(new Set(all).size).toBe(12); // stable: no repeats, none lost
      expect((await rep.get('/inquiries?search=ashish&status=OPEN&page=4&limit=5').expect(200)).body.data).toEqual([]);
    });
    it('search narrows within the status, and a status with no match for the search is empty', async () => {
      expect((await rep.get('/inquiries?search=ashish&status=CONTINUED').expect(200)).body.meta.total).toBe(0);
      expect((await rep.get('/inquiries?search=continued&status=CONTINUED&limit=100').expect(200)).body.meta.total).toBe(6);
      expect((await rep.get('/inquiries?search=continued&status=OPEN').expect(200)).body.meta.total).toBe(0);
    });
    it('the outsider matches "ashish" but never appears for this rep', async () => {
      const res = await rep.get('/inquiries?search=ashish&limit=100').expect(200);
      expect(res.body.meta.total).toBe(12);
    });
  });

  describe('sortBy / sortOrder', () => {
    it('defaults to newest first', async () => {
      const t = rows(await rep.get('/inquiries?limit=100').expect(200)).map((r) => r.id);
      const res = await rep.get('/inquiries?limit=100').expect(200);
      const created = (res.body.data as Array<{ createdAt: string }>).map((r) => r.createdAt);
      expect([...created].sort().reverse()).toEqual(created);
      expect(t).toHaveLength(25);
    });
    it('nextFollowupAt ascending: earliest first, leads with none LAST', async () => {
      const r = rows(await rep.get('/inquiries?sortBy=nextFollowupAt&sortOrder=asc&limit=100').expect(200));
      const dated = r.filter((x) => x.nextFollowupAt).map((x) => x.nextFollowupAt!);
      expect([...dated].sort()).toEqual(dated);
      const firstNull = r.findIndex((x) => !x.nextFollowupAt);
      expect(r.slice(firstNull).every((x) => !x.nextFollowupAt)).toBe(true);
      expect(dated.length).toBe(10); // 4 open + 6 continued
    });
    it('nextFollowupAt descending: latest first, leads with none still LAST', async () => {
      const r = rows(await rep.get('/inquiries?sortBy=nextFollowupAt&sortOrder=desc&limit=100').expect(200));
      const dated = r.filter((x) => x.nextFollowupAt).map((x) => x.nextFollowupAt!);
      expect([...dated].sort().reverse()).toEqual(dated);
      expect(r.slice(dated.length).every((x) => !x.nextFollowupAt)).toBe(true);
    });
    it('sorting by a non-unique field pages stably (id tie-break): no repeats, none lost', async () => {
      const seen: string[] = [];
      for (let page = 1; page <= 5; page++) seen.push(...ids(await rep.get(`/inquiries?sortBy=status&sortOrder=asc&limit=6&page=${page}`).expect(200)));
      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
    });
    it('rejects any field outside the whitelist (columns, relations, injection) with 400', async () => {
      for (const f of ['id', 'passwordHash', 'assignedToId', 'applicant.name', 'nope', 'createdAt;DROP%20TABLE%20inquiries']) await rep.get(`/inquiries?sortBy=${f}`).expect(400);
    });
    it('rejects an invalid sortOrder', async () => {
      await rep.get('/inquiries?sortBy=createdAt&sortOrder=sideways').expect(400);
    });
  });

  describe('validation and compatibility', () => {
    it('bad pagination is still a 400', async () => {
      for (const q of ['page=0', 'limit=101', 'limit=abc']) await rep.get(`/inquiries?status=OPEN&${q}`).expect(400);
    });
    it('unknown parameters are ignored, so existing callers keep working', async () => {
      const res = await rep.get('/inquiries?page=1&limit=5&_=1727000000000&utm=x').expect(200);
      expect(res.body.meta.total).toBe(25);
    });
    it('a malformed inquiry id is a 400, not a 500 (was: the ORM threw on the bad uuid)', async () => {
      await rep.get('/inquiries/not-a-uuid').expect(400);
      await rep.get('/inquiries/123').expect(400);
      // Authorization runs before the id is parsed: a reader is refused first, an editor gets the 400.
      await rep.patch('/inquiries/not-a-uuid', { status: 'OPEN' }).expect(403);
      await editor.patch('/inquiries/not-a-uuid', { status: 'OPEN' }).expect(400);
      await editor.patch('/inquiries/not-a-uuid/assign', {}).expect(400);
    });
    it('a well-formed id that is not visible to the caller is a 404, not a leak', async () => {
      await rep.get('/inquiries/00000000-0000-4000-8000-000000000000').expect(404);
    });
  });
});
