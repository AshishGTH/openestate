/**
 * v0.2.2: project_media_portal_scope / construction_update_media_portal_scope
 * are both multi-hop predicates (project reachable via a booking, not a
 * direct column) — per the Phase 6 commit 2 inclusion criterion, neither
 * is mirrored in tenant.extension.ts's PORTAL_SCOPED_MODELS, so RLS is the
 * SOLE enforcement. Same raw-connection discipline as portal-rls.test.ts:
 * a customer with a booking in project A must not be able to read either
 * table's rows for project B by guessing a media id, proven by querying
 * through a real withTenantTx/runWithTenant portal session, not a
 * request-constructing supertest that could mask a JS-level bypass.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runWithTenant, withTenantTx } from '@openestate/db';
import { makeClients, seedCompany, makeUnit, makeApplicant, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

interface CountRow {
  n: bigint;
}

describeIf('v0.2.2 ProjectMedia/ConstructionUpdateMedia portal RLS (IDOR)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;

  let applicantA: string;
  let applicantB: string;
  let projectBId: string;
  let projectMediaAId: string;
  let projectMediaBId: string;
  let constructionMediaAId: string;
  let constructionMediaBId: string;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    applicantA = await makeApplicant(systemPrisma, fx.companyId);
    applicantB = await makeApplicant(systemPrisma, fx.companyId);

    // Project A: fx's own project (already has a tower/floor from seedCompany).
    const unitA = await makeUnit(systemPrisma, fx);
    await systemPrisma.booking.create({
      data: {
        companyId: fx.companyId,
        unitId: unitA,
        primaryApplicantId: applicantA,
        bookingNumber: `PM-A-${Date.now()}`,
        agreedPricePaise: BigInt(20_00_000_00),
        bookingDate: new Date('2026-06-01'),
      },
    });

    // Project B: an entirely separate project/tower/floor/unit/booking,
    // reachable only by applicant B.
    const projectB = await systemPrisma.project.create({
      data: { companyId: fx.companyId, name: `PM Project B ${Date.now()}`, code: `PMB-${Date.now()}` },
    });
    projectBId = projectB.id;
    const towerB = await systemPrisma.tower.create({
      data: { companyId: fx.companyId, projectId: projectBId, name: 'Tower B', code: 'TB' },
    });
    const floorB = await systemPrisma.floor.create({
      data: { companyId: fx.companyId, towerId: towerB.id, name: 'Floor B', floorNumber: 1 },
    });
    const unitB = await systemPrisma.unit.create({
      data: {
        companyId: fx.companyId,
        projectId: projectBId,
        shape: 'HIGH_RISE',
        floorId: floorB.id,
        number: `UB-${Date.now()}`,
        status: 'AVAILABLE',
      },
    });
    await systemPrisma.booking.create({
      data: {
        companyId: fx.companyId,
        unitId: unitB.id,
        primaryApplicantId: applicantB,
        bookingNumber: `PM-B-${Date.now()}`,
        agreedPricePaise: BigInt(20_00_000_00),
        bookingDate: new Date('2026-06-01'),
      },
    });

    const mediaA = await systemPrisma.projectMedia.create({
      data: {
        companyId: fx.companyId,
        projectId: fx.projectId,
        category: 'layout_plan',
        storedName: 'a.pdf',
        originalName: 'Layout A.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
      },
    });
    projectMediaAId = mediaA.id;
    const mediaB = await systemPrisma.projectMedia.create({
      data: {
        companyId: fx.companyId,
        projectId: projectBId,
        category: 'layout_plan',
        storedName: 'b.pdf',
        originalName: 'Layout B.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
      },
    });
    projectMediaBId = mediaB.id;

    const cuA = await systemPrisma.constructionUpdate.create({
      data: { companyId: fx.companyId, projectId: fx.projectId, title: 'Update A', publishedAt: new Date('2026-06-01') },
    });
    const cuMediaA = await systemPrisma.constructionUpdateMedia.create({
      data: {
        companyId: fx.companyId,
        constructionUpdateId: cuA.id,
        storedName: 'ca.jpg',
        originalName: 'Progress A.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 100,
      },
    });
    constructionMediaAId = cuMediaA.id;

    const cuB = await systemPrisma.constructionUpdate.create({
      data: { companyId: fx.companyId, projectId: projectBId, title: 'Update B', publishedAt: new Date('2026-06-01') },
    });
    const cuMediaB = await systemPrisma.constructionUpdateMedia.create({
      data: {
        companyId: fx.companyId,
        constructionUpdateId: cuB.id,
        storedName: 'cb.jpg',
        originalName: 'Progress B.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 100,
      },
    });
    constructionMediaBId = cuMediaB.id;
  });

  afterAll(async () => {
    await systemPrisma.constructionUpdateMedia.deleteMany({ where: { companyId: fx.companyId } });
    await systemPrisma.constructionUpdate.deleteMany({ where: { companyId: fx.companyId } });
    await systemPrisma.projectMedia.deleteMany({ where: { companyId: fx.companyId } });
    await systemPrisma.booking.deleteMany({ where: { companyId: fx.companyId } });
    await systemPrisma.unit.deleteMany({ where: { companyId: fx.companyId, floorId: { not: fx.floorId } } });
    await systemPrisma.floor.deleteMany({ where: { companyId: fx.companyId, id: { not: fx.floorId } } });
    await systemPrisma.tower.deleteMany({ where: { companyId: fx.companyId, id: { not: fx.towerId } } });
    await systemPrisma.project.delete({ where: { id: projectBId } });
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  async function countAsPortalApplicant(applicantId: string, sql: string): Promise<number> {
    return runWithTenant({ companyId: fx.companyId, portalApplicantId: applicantId }, () =>
      withTenantTx(tenantPrisma, fx.companyId, async (tx) => {
        const rows = await (tx as { $queryRawUnsafe: (q: string) => Promise<CountRow[]> }).$queryRawUnsafe(sql);
        return Number(rows[0].n);
      }),
    );
  }

  it('IDOR: applicant A sees their own project_media row but not project B\'s', async () => {
    const own = await countAsPortalApplicant(applicantA, `SELECT count(*)::bigint AS n FROM project_media WHERE id = '${projectMediaAId}'`);
    expect(own).toBe(1);
    const other = await countAsPortalApplicant(applicantA, `SELECT count(*)::bigint AS n FROM project_media WHERE id = '${projectMediaBId}'`);
    expect(other).toBe(0);
  });

  it('IDOR: applicant B sees their own project_media row but not project A\'s', async () => {
    const own = await countAsPortalApplicant(applicantB, `SELECT count(*)::bigint AS n FROM project_media WHERE id = '${projectMediaBId}'`);
    expect(own).toBe(1);
    const other = await countAsPortalApplicant(applicantB, `SELECT count(*)::bigint AS n FROM project_media WHERE id = '${projectMediaAId}'`);
    expect(other).toBe(0);
  });

  it('IDOR: applicant A sees their own construction_update_media row but not project B\'s', async () => {
    const own = await countAsPortalApplicant(
      applicantA,
      `SELECT count(*)::bigint AS n FROM construction_update_media WHERE id = '${constructionMediaAId}'`,
    );
    expect(own).toBe(1);
    const other = await countAsPortalApplicant(
      applicantA,
      `SELECT count(*)::bigint AS n FROM construction_update_media WHERE id = '${constructionMediaBId}'`,
    );
    expect(other).toBe(0);
  });
});
