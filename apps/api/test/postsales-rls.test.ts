/**
 * RLS isolation on the Phase 4 financial tables, raw-connection style: a
 * filter-less query inside company A's tenant transaction must never see
 * company B's rows.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SYSTEM_CLOCK } from '@openestate/shared';
import { runWithTenant, withTenantTx } from '@openestate/db';
import {
  makeClients,
  buildServices,
  seedCompany,
  makeUnit,
  makeApplicant,
  cleanupCompany,
  type Services,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const PHASE4_TABLES = [
  'bookings', 'booking_co_applicants', 'booking_cost_lines', 'payment_plans',
  'installments', 'ledger_entries', 'receipts', 'receipt_allocations',
  'cheque_status_events', 'number_sequences', 'transfers', 'cancellations',
  'refunds', 'payment_vouchers', 'extra_charges', 'tds_deductions',
  'tds_certificates', 'interest_accruals', 'applicant_addresses',
  'applicant_documents', 'cancellation_rules', 'payment_plan_milestones',
];

describeIf('Phase 4 financial tenant isolation (RLS)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let fxA: CompanyFixture;
  let fxB: CompanyFixture;
  let bookingBId: string;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    fxA = await seedCompany(systemPrisma);
    fxB = await seedCompany(systemPrisma);
    // Give company A a booking with a receipt (rows across many tables).
    const unitA = await makeUnit(systemPrisma, fxA);
    const appA = await makeApplicant(systemPrisma, fxA.companyId);
    const bA = await svc.bookings.createBooking(
      fxA.companyId,
      { unitId: unitA, primaryApplicantId: appA, coApplicantIds: [], bookingDate: new Date('2026-06-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 10_00_000n * 100n, gstRateId: fxA.defaultGstRateId }] },
      fxA.userId,
    );
    // And company B a separate booking.
    const unitB = await makeUnit(systemPrisma, fxB);
    const appB = await makeApplicant(systemPrisma, fxB.companyId);
    const bB = await svc.bookings.createBooking(
      fxB.companyId,
      { unitId: unitB, primaryApplicantId: appB, coApplicantIds: [], bookingDate: new Date('2026-06-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 20_00_000n * 100n, gstRateId: fxB.defaultGstRateId }] },
      fxB.userId,
    );
    bookingBId = bB.id;
    void bA;
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fxA.companyId);
    await cleanupCompany(systemPrisma, fxB.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('company A cannot see company B bookings/ledger even with a filter-less raw query', async () => {
    const bookingLeak = await runWithTenant({ companyId: fxA.companyId }, () =>
      withTenantTx(tenantPrisma, fxA.companyId, async (tx) => {
        const rows = await (tx as { $queryRawUnsafe: (q: string) => Promise<{ n: bigint }[]> }).$queryRawUnsafe(
          `SELECT count(*)::bigint AS n FROM bookings WHERE id = '${bookingBId}'`,
        );
        return Number(rows[0].n);
      }),
    );
    expect(bookingLeak).toBe(0);

    const ledgerLeak = await runWithTenant({ companyId: fxA.companyId }, () =>
      withTenantTx(tenantPrisma, fxA.companyId, async (tx) => {
        // No WHERE company_id — RLS itself must restrict to company A.
        const rows = await (tx as { $queryRawUnsafe: (q: string) => Promise<{ n: bigint }[]> }).$queryRawUnsafe(
          `SELECT count(*)::bigint AS n FROM ledger_entries WHERE booking_id = '${bookingBId}'`,
        );
        return Number(rows[0].n);
      }),
    );
    expect(ledgerLeak).toBe(0);
  });

  it.each(PHASE4_TABLES)('table %s is RLS-isolated (A + B counts never exceed the true total)', async (table) => {
    const countAs = (companyId: string) =>
      runWithTenant({ companyId }, () =>
        withTenantTx(tenantPrisma, companyId, async (tx) => {
          const rows = await (tx as { $queryRawUnsafe: (q: string) => Promise<{ n: bigint }[]> }).$queryRawUnsafe(
            `SELECT count(*)::bigint AS n FROM ${table}`,
          );
          return Number(rows[0].n);
        }),
      );
    const a = await countAs(fxA.companyId);
    const b = await countAs(fxB.companyId);
    const total: bigint = (
      await systemPrisma.$queryRawUnsafe(`SELECT count(*)::bigint AS n FROM ${table}`)
    )[0].n;
    expect(a + b).toBeLessThanOrEqual(Number(total));
  });
});
