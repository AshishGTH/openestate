/**
 * GET /inquiries/:id/activity (API_GAPS G7), through the real HTTP pipeline.
 * Only real, stored events; scoped like the lead; follow-up notes need their
 * own permission; stable merged ordering across pages.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { bootstrapApp, cleanupLeads, describeIfDb, ensurePermissions, loginStaff, makeLead, makeRole, makeUser, type Session } from './helpers/inquiry-list-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Prisma = any;

describeIfDb('e2e GET /inquiries/:id/activity', () => {
  let app: INestApplication;
  let prisma: Prisma;
  let fx: CompanyFixture;
  let other: CompanyFixture;
  let full: Session;
  let noFollowUp: Session;
  let noRead: Session;
  let foreign: Session;
  let leadId: string;
  let strangerLeadId: string;
  let otherLeadId: string;
  const min = 60_000;
  const t0 = Date.now() - 100 * min;
  const at = (m: number) => new Date(t0 + m * min);

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma: prisma } = makeClients());
    fx = await seedCompany(prisma);
    other = await seedCompany(prisma);
    const perms = await ensurePermissions(prisma);
    const fullRole = await makeRole(prisma, fx.companyId, 'act-full', [PERMISSIONS.PRESALES_INQUIRY_READ, PERMISSIONS.PRESALES_FOLLOW_UP_READ], perms);
    const bareRole = await makeRole(prisma, fx.companyId, 'act-bare', [PERMISSIONS.PRESALES_INQUIRY_READ], perms);
    const wrongRole = await makeRole(prisma, fx.companyId, 'act-wrong', [PERMISSIONS.PRESALES_FOLLOW_UP_READ], perms);
    const otherRole = await makeRole(prisma, other.companyId, 'act-other', [PERMISSIONS.PRESALES_INQUIRY_READ, PERMISSIONS.PRESALES_FOLLOW_UP_READ], perms);
    // bare (no follow-up read) manages m, so it sees m's lead through the team scope.
    const bare = await makeUser(prisma, fx.companyId, bareRole.id, 'Act Bare');
    const m = await makeUser(prisma, fx.companyId, fullRole.id, 'Act Manager', { managerId: bare.id });
    const nr = await makeUser(prisma, fx.companyId, wrongRole.id, 'Act NoRead');
    const stranger = await makeUser(prisma, fx.companyId, fullRole.id, 'Act Stranger');
    const f = await makeUser(prisma, other.companyId, otherRole.id, 'Act Foreign');
    void nr;

    const c = fx.companyId;
    ({ inquiryId: leadId } = await makeLead(prisma, { companyId: c, assignedToId: m.id, name: 'Act Lead', phone: '7400000001' }));
    ({ inquiryId: strangerLeadId } = await makeLead(prisma, { companyId: c, assignedToId: stranger.id, name: 'Act Other Lead', phone: '7400000002' }));
    ({ inquiryId: otherLeadId } = await makeLead(prisma, { companyId: other.companyId, assignedToId: f.id, name: 'Act Foreign Lead', phone: '7400000003' }));

    const stageA = await prisma.leadStage.create({ data: { companyId: c, name: 'Act New', sortOrder: 1 } });
    const stageB = await prisma.leadStage.create({ data: { companyId: c, name: 'Act Contacted', sortOrder: 2 } });
    const visitType = await prisma.followUpType.create({ data: { companyId: c, name: 'Act Visit', isSiteVisit: true } });
    const reason = await prisma.dumpReason.create({ data: { companyId: c, name: 'Act Budget' } });

    // Oldest to newest, one per kind, plus two events at the SAME instant to prove a stable order.
    await prisma.inquiryAssignment.create({ data: { companyId: c, inquiryId: leadId, toUserId: m.id, assignmentType: 'MANUAL', actorId: m.id, createdAt: at(1) } });
    await prisma.inquiryStageHistory.create({ data: { companyId: c, inquiryId: leadId, toStageId: stageA.id, changedById: m.id, changedAt: at(2) } });
    await prisma.followUp.create({ data: { companyId: c, inquiryId: leadId, typeId: visitType.id, notes: 'Called, wants a visit', interactionAt: at(3), scheduledAt: at(60), venue: 'Site office', createdById: m.id } });
    await prisma.inquiryStageHistory.create({ data: { companyId: c, inquiryId: leadId, fromStageId: stageA.id, toStageId: stageB.id, changedById: m.id, changedAt: at(4) } });
    await prisma.inquiryDispositionHistory.create({ data: { companyId: c, inquiryId: leadId, fromStatus: 'OPEN', toStatus: 'DUMPED', reasonId: reason.id, remarks: 'Out of budget', changedById: m.id, changedAt: at(5) } });
    await prisma.followUp.create({ data: { companyId: c, inquiryId: leadId, notes: 'tie-1', interactionAt: at(6), createdById: m.id } });
    await prisma.followUp.create({ data: { companyId: c, inquiryId: leadId, notes: 'tie-2', interactionAt: at(6), createdById: m.id } });
    // Noise that must never appear
    await prisma.followUp.create({ data: { companyId: c, inquiryId: strangerLeadId, notes: 'stranger-note', interactionAt: at(7) } });

    full = await loginStaff(app, m.email);
    noFollowUp = await loginStaff(app, bare.email);
    noRead = await loginStaff(app, nr.email);
    foreign = await loginStaff(app, f.email);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    for (const f of [fx, other]) {
      await cleanupLeads(prisma, f.companyId);
      await prisma.inquiryDispositionHistory.deleteMany({ where: { companyId: f.companyId } });
      await prisma.inquiryAssignment.deleteMany({ where: { companyId: f.companyId } });
      await prisma.inquiryStageHistory.deleteMany({ where: { companyId: f.companyId } });
      await prisma.leadStage.deleteMany({ where: { companyId: f.companyId } });
      await prisma.dumpReason.deleteMany({ where: { companyId: f.companyId } });
      await prisma.followUpType.deleteMany({ where: { companyId: f.companyId } });
      await cleanupCompany(prisma, f.companyId);
    }
  });

  const get = (s: Session, id: string, q = '') => s.get(`/inquiries/${id}/activity${q}`);

  describe('authentication and authorization', () => {
    it('no token -> 401', async () => {
      await request(app.getHttpServer()).get(`/api/v1/inquiries/${leadId}/activity`).expect(401);
    });
    it('a role without presales.inquiry.read -> 403', async () => {
      await get(noRead, leadId).expect(403);
    });
    it('a lead outside the caller\'s team -> 404, not an empty feed', async () => {
      await get(full, strangerLeadId).expect(404);
    });
    it('a lead in another company -> 404', async () => {
      await get(full, otherLeadId).expect(404);
      await get(foreign, leadId).expect(404);
    });
    it('a malformed or unknown id: 400 / 404', async () => {
      await get(full, 'not-a-uuid').expect(400);
      await get(full, '00000000-0000-4000-8000-000000000000').expect(404);
    });
  });

  describe('content', () => {
    it('merges every real kind, newest first, with structured details', async () => {
      const r = (await get(full, leadId).expect(200)).body;
      expect(r.meta).toEqual({ page: 1, limit: 20, total: 7, totalPages: 1, types: ['follow_up', 'stage_change', 'status_change', 'assignment'] });
      const times = r.data.map((i: { occurredAt: string }) => new Date(i.occurredAt).getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
      const byType = (ty: string) => r.data.filter((i: { type: string }) => i.type === ty);
      expect(byType('follow_up')).toHaveLength(3);
      expect(byType('stage_change')).toHaveLength(2);
      const visit = byType('follow_up').find((i: { details: { notes: string } }) => i.details.notes === 'Called, wants a visit');
      expect(visit.details).toMatchObject({ isSiteVisit: true, venue: 'Site office', followUpType: { name: 'Act Visit' } });
      expect(visit.actor.name).toBe('Act Manager');
      const status = byType('status_change')[0];
      expect(status.details).toMatchObject({ from: 'OPEN', to: 'DUMPED', remarks: 'Out of budget', reason: { name: 'Act Budget' } });
      const stage = byType('stage_change').find((i: { details: { from: unknown } }) => i.details.from);
      expect(stage.details).toMatchObject({ from: { name: 'Act New' }, to: { name: 'Act Contacted' }, administrative: false });
      expect(byType('assignment')[0].details).toMatchObject({ assignmentType: 'MANUAL', to: { name: 'Act Manager' } });
      expect(JSON.stringify(r)).not.toMatch(/stranger-note|passwordHash|totpSecret|recoveryCodes/);
    });
    it('every item id is unique and prefixed by its kind', async () => {
      const r = (await get(full, leadId).expect(200)).body;
      const ids = r.data.map((i: { id: string }) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id: string, k: number) => id.startsWith(`${r.data[k].type}:`))).toBe(true);
    });
  });

  describe('permissions decide which kinds are included', () => {
    it('without follow-up read, follow-up notes are not in the feed (and meta says so)', async () => {
      const r = (await get(noFollowUp, leadId).expect(200)).body;
      expect(r.meta.types).toEqual(['stage_change', 'status_change', 'assignment']);
      expect(r.meta.total).toBe(4);
      expect(JSON.stringify(r)).not.toMatch(/wants a visit|tie-1/);
    });
    it('explicitly asking for follow_up without the permission returns none, not the notes', async () => {
      const r = (await get(noFollowUp, leadId, '?type=follow_up').expect(200)).body;
      expect(r.data).toEqual([]);
      expect(r.meta.total).toBe(0);
    });
  });

  describe('type filter', () => {
    it('narrows to the requested kinds (comma or repeated)', async () => {
      expect((await get(full, leadId, '?type=assignment').expect(200)).body.meta.total).toBe(1);
      expect((await get(full, leadId, '?type=stage_change,status_change').expect(200)).body.meta.total).toBe(3);
      expect((await get(full, leadId, '?type=stage_change&type=assignment').expect(200)).body.meta.total).toBe(3);
    });
    it('an unknown kind is 400', async () => {
      await get(full, leadId, '?type=communication').expect(400);
      await get(full, leadId, '?type=call').expect(400);
    });
  });

  describe('pagination', () => {
    it('pages are disjoint, complete and stable even with events at the same instant', async () => {
      const seen: string[] = [];
      for (const page of [1, 2, 3, 4]) {
        const r = (await get(full, leadId, `?limit=2&page=${page}`).expect(200)).body;
        expect(r.meta).toMatchObject({ page, limit: 2, total: 7, totalPages: 4 });
        seen.push(...r.data.map((i: { id: string }) => i.id));
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      const all = (await get(full, leadId).expect(200)).body.data.map((i: { id: string }) => i.id);
      expect(seen).toEqual(all);
    });
    it('a page past the end is empty with the same total', async () => {
      const r = (await get(full, leadId, '?limit=2&page=9').expect(200)).body;
      expect(r.data).toEqual([]);
      expect(r.meta.total).toBe(7);
    });
    it.each(['page=0', 'page=11', 'limit=0', 'limit=101', 'page=abc'])('%s is 400', async (q) => {
      await get(full, leadId, `?${q}`).expect(400);
    });
    it('a lead with no activity returns an empty first page', async () => {
      const c = fx.companyId;
      const m = await prisma.user.findFirst({ where: { companyId: c, name: 'Act Manager' } });
      const { inquiryId } = await makeLead(prisma, { companyId: c, assignedToId: m.id, name: 'Act Empty', phone: '7400000004' });
      const r = (await get(full, inquiryId).expect(200)).body;
      expect(r.data).toEqual([]);
      expect(r.meta.total).toBe(0);
    });
  });
});
