/**
 * v0.2.3: custom field VALUES are tenant-scoped data living inline as
 * JSONB on an already-RLS-protected row, so they inherit that row's
 * isolation rather than needing a policy of their own — that
 * zero-new-isolation-surface property is the main argument for storing
 * them inline instead of in a separate EAV table.
 *
 * "It should inherit" is exactly the kind of assumption this project
 * has been burned by (Phase 6's PORTAL_SCOPED_MODELS gaps), so it is
 * proven here through a raw connection under a real tenant session,
 * not asserted.
 *
 * Also covers the SECURITY fix: portal responses must not carry
 * customFields at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runWithTenant, withTenantTx } from '@openestate/db';
import { makeClients, seedCompany, makeApplicant, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

interface CountRow {
  n: bigint;
}

describeIf('v0.2.3 custom field value isolation', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let companyA: CompanyFixture;
  let companyB: CompanyFixture;
  let applicantA: string;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    companyA = await seedCompany(systemPrisma);
    companyB = await seedCompany(systemPrisma);

    applicantA = await makeApplicant(systemPrisma, companyA.companyId);
    await systemPrisma.applicant.update({
      where: { id: applicantA },
      data: { customFields: { secret_note: 'company A internal' } },
    });
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, companyA.companyId);
    await cleanupCompany(systemPrisma, companyB.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  async function countAs(companyId: string, sql: string): Promise<number> {
    return runWithTenant({ companyId }, () =>
      withTenantTx(tenantPrisma, companyId, async (tx) => {
        const rows = await (tx as { $queryRawUnsafe: (q: string) => Promise<CountRow[]> }).$queryRawUnsafe(sql);
        return Number(rows[0].n);
      }),
    );
  }

  it("company B cannot read company A's custom field values, even via a raw JSONB predicate", async () => {
    // Filter-less by company on purpose: RLS, not the query, must be
    // what restricts this.
    const own = await countAs(
      companyA.companyId,
      `SELECT count(*)::bigint AS n FROM applicants WHERE custom_fields ->> 'secret_note' = 'company A internal'`,
    );
    expect(own).toBe(1);

    const other = await countAs(
      companyB.companyId,
      `SELECT count(*)::bigint AS n FROM applicants WHERE custom_fields ->> 'secret_note' = 'company A internal'`,
    );
    expect(other).toBe(0);
  });

  it('the new unit/project columns are equally isolated', async () => {
    await systemPrisma.project.update({
      where: { id: companyA.projectId },
      data: { customFields: { internal_code: 'A-ONLY' } },
    });

    const own = await countAs(
      companyA.companyId,
      `SELECT count(*)::bigint AS n FROM projects WHERE custom_fields ->> 'internal_code' = 'A-ONLY'`,
    );
    expect(own).toBe(1);

    const other = await countAs(
      companyB.companyId,
      `SELECT count(*)::bigint AS n FROM projects WHERE custom_fields ->> 'internal_code' = 'A-ONLY'`,
    );
    expect(other).toBe(0);
  });

  it('PortalProfileService withholds customFields from the customer and their co-applicants', async () => {
    // Direct service construction (the pattern used throughout this
    // suite) — the point here is the omit shape, and the RLS/portal
    // scope it runs under is already covered by portal-rls.test.ts.
    const require = (await import('node:module')).createRequire(import.meta.url);
    const { PortalProfileService } = require('../dist/customer-portal/portal-profile.service');
    const service = new PortalProfileService(tenantPrisma);

    const profile = await runWithTenant(
      { companyId: companyA.companyId, portalApplicantId: applicantA },
      () => service.getProfile(companyA.companyId, applicantA),
    );

    expect(profile.self.id).toBe(applicantA);
    // The applicant genuinely HAS a stored value — this asserts it was
    // withheld, not that there was nothing to withhold.
    expect('customFields' in profile.self).toBe(false);
    for (const co of profile.coApplicants) {
      expect('customFields' in co).toBe(false);
    }

    const stored = await systemPrisma.applicant.findUnique({ where: { id: applicantA } });
    expect(stored.customFields).toEqual({ secret_note: 'company A internal' });
  });
});
