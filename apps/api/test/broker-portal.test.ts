/**
 * Phase 6 commit 3 (broker-portal): commission dashboard, NOC portal
 * action, and self-service commission-statement downloads — all reusing
 * Phase 5's NocService/DocumentService unchanged, scoped entirely by
 * PORTAL_SCOPED_MODELS (CommissionLedgerEntry, BrokerNoc, Broker are all
 * direct-column entries) + RLS's broker branch (Booking, GeneratedDocument).
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Reflector } from '@nestjs/core';
import { runWithTenant } from '@openestate/db';
import { PERMISSIONS, SYSTEM_ROLES, ROLE_PERMISSIONS, NOC_STATUS, COMMISSION_ENTRY_TYPE } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { PermissionsGuard } from '../src/auth/guards/permissions.guard';
import { NocService } from '../src/brokers/noc.service';
import { PortalBrokerDashboardService } from '../src/brokers-portal/portal-broker-dashboard.service';
import { DocumentService } from '../src/pdf/document.service';
import { PdfService } from '../src/pdf/pdf.service';
import { UploadService } from '../src/inventory/upload.service';
import { LedgerService } from '../src/postsales/ledger.service';
import {
  makeClients,
  seedCompany,
  makeUnit,
  makeBroker,
  makeApplicant,
  makePortalRole,
  cleanupCompany,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

describeIf('Phase 6 broker-portal (commit 3)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let nocs: NocService;
  let dashboard: PortalBrokerDashboardService;
  let documents: DocumentService;

  /**
   * Same discipline as customer-portal.test.ts's asPortalApplicant: these
   * services deliberately do NOT self-wrap runWithTenant (production
   * establishes ambient scope via TenantContextInterceptor) — proves the
   * service's OWN logic is correct given a correctly-populated ambient
   * context, NOT that the context actually gets populated on a real
   * request. The through-the-wire proof for every new controller here
   * lives in test/e2e-portal.test.ts.
   */
  function asPortalBroker<T>(brokerId: string, fn: () => Promise<T>): Promise<T> {
    return runWithTenant({ companyId: fx.companyId, portalBrokerId: brokerId }, fn);
  }

  async function makeBooking(brokerId: string | null, unitId: string, bookingNumber: string) {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const b = await systemPrisma.booking.create({
      data: {
        companyId: fx.companyId,
        unitId,
        primaryApplicantId: applicantId,
        bookingNumber,
        agreedPricePaise: BigInt(20_00_000_00),
        bookingDate: new Date('2026-06-01'),
        brokerId,
      },
    });
    return b.id as string;
  }

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    await makePortalRole(systemPrisma, fx.companyId, 'customer');
    await makePortalRole(systemPrisma, fx.companyId, 'broker');

    nocs = new NocService(tenantPrisma, systemPrisma);
    dashboard = new PortalBrokerDashboardService(tenantPrisma);
    const ledger = new LedgerService(tenantPrisma);
    documents = new DocumentService(tenantPrisma, systemPrisma, new PdfService(), new UploadService(), ledger);
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  // ── NOC portal action ───────────────────────────────────────

  it('NOC portal action creates no new row — approving via the portal transitions the SAME BrokerNoc row a staff approve() would', async () => {
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    const unitId = await makeUnit(systemPrisma, fx);
    const bookingId = await makeBooking(brokerId, unitId, `NOC-${Date.now()}`);

    const noc = await nocs.request(fx.companyId, bookingId, {}, fx.userId);
    const countBefore = await systemPrisma.brokerNoc.count({ where: { companyId: fx.companyId, bookingId } });
    expect(countBefore).toBe(1);

    const approved = await asPortalBroker(brokerId, () => nocs.approve(fx.companyId, noc.id, fx.userId));

    expect(approved.id).toBe(noc.id); // same row, not a new one
    expect(approved.status).toBe(NOC_STATUS.APPROVED);
    const countAfter = await systemPrisma.brokerNoc.count({ where: { companyId: fx.companyId, bookingId } });
    expect(countAfter).toBe(1); // still exactly one row for this booking
  });

  it('NOC portal IDOR: broker A cannot approve broker B\'s NOC — 404s before any write, broker B can', async () => {
    const brokerA = await makeBroker(systemPrisma, fx.companyId);
    const brokerB = await makeBroker(systemPrisma, fx.companyId);
    const unitId = await makeUnit(systemPrisma, fx);
    const bookingId = await makeBooking(brokerB, unitId, `NOCB-${Date.now()}`);

    const noc = await nocs.request(fx.companyId, bookingId, {}, fx.userId);

    await expect(asPortalBroker(brokerA, () => nocs.approve(fx.companyId, noc.id, fx.userId))).rejects.toThrow();

    const stillRequested = await systemPrisma.brokerNoc.findUniqueOrThrow({ where: { id: noc.id } });
    expect(stillRequested.status).toBe(NOC_STATUS.REQUESTED); // broker A's attempt changed nothing

    const approved = await asPortalBroker(brokerB, () => nocs.approve(fx.companyId, noc.id, fx.userId));
    expect(approved.status).toBe(NOC_STATUS.APPROVED); // the actual owner can
  });

  it('listForBroker: a broker sees only their own NOCs, with booking numbers resolved', async () => {
    const brokerA = await makeBroker(systemPrisma, fx.companyId);
    const brokerB = await makeBroker(systemPrisma, fx.companyId);
    const unitA = await makeUnit(systemPrisma, fx);
    const unitB = await makeUnit(systemPrisma, fx);
    const bookingA = await makeBooking(brokerA, unitA, `NOCL-A-${Date.now()}`);
    const bookingB = await makeBooking(brokerB, unitB, `NOCL-B-${Date.now()}`);
    await nocs.request(fx.companyId, bookingA, {}, fx.userId);
    await nocs.request(fx.companyId, bookingB, {}, fx.userId);

    const listA = await asPortalBroker(brokerA, () => nocs.listForBroker(fx.companyId, brokerA));
    expect(listA).toHaveLength(1);
    expect(listA[0].bookingId).toBe(bookingA);
    expect(listA[0].bookingNumber).toMatch(/^NOCL-A-/);
  });

  // ── Dashboard scoping ───────────────────────────────────────

  it('dashboard: commission totals and sold-units count are scoped to the ambient broker only, never leaking another broker\'s figures', async () => {
    const brokerA = await makeBroker(systemPrisma, fx.companyId);
    const brokerB = await makeBroker(systemPrisma, fx.companyId);
    const unitA = await makeUnit(systemPrisma, fx);
    const unitB = await makeUnit(systemPrisma, fx);
    const bookingA = await makeBooking(brokerA, unitA, `DASH-A-${Date.now()}`);
    await makeBooking(brokerB, unitB, `DASH-B-${Date.now()}`);

    await systemPrisma.commissionLedgerEntry.create({
      data: {
        companyId: fx.companyId,
        brokerId: brokerA,
        bookingId: bookingA,
        entryType: COMMISSION_ENTRY_TYPE.ACCRUAL,
        signedAmountPaise: BigInt(10_000_00),
        effectiveDate: new Date('2026-06-15'),
      },
    });
    await systemPrisma.commissionLedgerEntry.create({
      data: {
        companyId: fx.companyId,
        brokerId: brokerB,
        bookingId: bookingA,
        entryType: COMMISSION_ENTRY_TYPE.ACCRUAL,
        signedAmountPaise: BigInt(99_999_00),
        effectiveDate: new Date('2026-06-15'),
      },
    });

    const view = await asPortalBroker(brokerA, () => dashboard.getDashboard(fx.companyId, brokerA));
    expect(view.commission.accruedFormatted).toContain('10,000');
    expect(view.commission.accruedFormatted).not.toContain('99,999');
    expect(view.soldUnitsCount).toBe(1); // only brokerA's booking, not brokerB's
  });

  // ── Statement documents ─────────────────────────────────────

  it('broker statement documents: listForBrokerPortal and download are scoped to the ambient broker; content hash is stable across downloads', async () => {
    const brokerA = await makeBroker(systemPrisma, fx.companyId);
    const brokerB = await makeBroker(systemPrisma, fx.companyId);

    const docA = await documents.generateBrokerStatementPdf(fx.companyId, brokerA, fx.userId);
    await documents.generateBrokerStatementPdf(fx.companyId, brokerB, fx.userId);

    const listA = await asPortalBroker(brokerA, () => documents.listForBrokerPortal(fx.companyId, brokerA));
    expect(listA.map((d: { id: string }) => d.id)).toEqual([docA.id]);

    const first = await asPortalBroker(brokerA, () => documents.getDocumentBytesForPortal(fx.companyId, docA.id));
    const second = await asPortalBroker(brokerA, () => documents.getDocumentBytesForPortal(fx.companyId, docA.id));
    expect(first.buffer.equals(second.buffer)).toBe(true);

    // Broker B's own token cannot reach A's statement — RLS's broker
    // branch on generated_documents_portal_scope (Phase 6 commit 2).
    await expect(
      asPortalBroker(brokerB, () => documents.getDocumentBytesForPortal(fx.companyId, docA.id)),
    ).rejects.toThrow();
  });

  // ── Bypass audit ────────────────────────────────────────────

  function makeGuardContext(user: JwtPayload, requiredPerms: string[]) {
    const reflector = new Reflector();
    const guard = new PermissionsGuard(reflector);
    reflector.getAllAndOverride = () => requiredPerms as never;
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => ({}),
      getClass: () => ({}),
    };
    return { guard, context: context as never };
  }

  it("bypass audit: the customer role's permission set contains neither PORTAL_NOC_ACTION nor REPORTS_BROKER_VIEW", () => {
    const brokerOnlyPerms = [PERMISSIONS.PORTAL_NOC_ACTION, PERMISSIONS.REPORTS_BROKER_VIEW];
    const overlap = ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER].filter((p) => (brokerOnlyPerms as string[]).includes(p));
    expect(overlap).toEqual([]);
  });

  it.each([PERMISSIONS.PORTAL_NOC_ACTION, PERMISSIONS.REPORTS_BROKER_VIEW])(
    'bypass audit: a customer-role JWT is rejected by PermissionsGuard for %s',
    (permission) => {
      const portalUser: JwtPayload = {
        sub: 'portal-user',
        companyId: fx.companyId,
        email: null,
        roleSlug: SYSTEM_ROLES.CUSTOMER,
        permissions: [...ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER]],
      };
      const { guard, context } = makeGuardContext(portalUser, [permission]);
      expect(() => guard.canActivate(context)).toThrow();
    },
  );
});
