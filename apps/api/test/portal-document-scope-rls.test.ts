/**
 * Raw-connection RLS proof for the narrowed portal policies (the database is
 * the primary line of defence; these tests go straight to it with a portal
 * session, never through a route).
 *
 *  - A broker session sees NO row of installments, payment_plans, receipts,
 *    receipt_allocations, ledger_entries or document_dispatches for a booking
 *    that broker sourced, and in generated_documents sees only its own
 *    BROKER_STATEMENT rows.
 *  - A customer session (primary and co-applicant) still sees every one of
 *    those rows for its own booking, and every document type on it.
 *  - Staff (no portal scope) is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runWithTenant, withTenantTx } from '@openestate/db';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { buildDocScopeFixture, type DocScopeFixture } from './helpers/portal-doc-scope-fixture';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

describeIf('Narrowed portal RLS: document and booking-money tables (raw connection)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let f: DocScopeFixture;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    f = await buildDocScopeFixture(tenantPrisma, systemPrisma, fx);
  }, 120_000);

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  async function count(scope: { portalApplicantId?: string; portalBrokerId?: string }, sql: string): Promise<number> {
    return runWithTenant({ companyId: fx.companyId, ...scope }, () =>
      withTenantTx(tenantPrisma, fx.companyId, async (tx) => {
        const rows = await (tx as { $queryRawUnsafe: (q: string) => Promise<Array<{ n: bigint }>> }).$queryRawUnsafe(sql);
        return Number(rows[0].n);
      }),
    );
  }
  const asBroker = (id: string, sql: string) => count({ portalBrokerId: id }, sql);
  const asCustomer = (id: string, sql: string) => count({ portalApplicantId: id }, sql);
  const asStaff = (sql: string) => count({}, sql);

  const B = () => `'${f.bookingId}'`;
  const bookingTables = (): Array<[string, string]> => [
    ['installments', `SELECT count(*) AS n FROM installments WHERE booking_id = ${B()}`],
    ['payment_plans', `SELECT count(*) AS n FROM payment_plans WHERE booking_id = ${B()}`],
    ['receipts', `SELECT count(*) AS n FROM receipts WHERE booking_id = ${B()}`],
    ['ledger_entries', `SELECT count(*) AS n FROM ledger_entries WHERE booking_id = ${B()}`],
    [
      'receipt_allocations',
      `SELECT count(*) AS n FROM receipt_allocations WHERE receipt_id IN (SELECT id FROM receipts WHERE booking_id = ${B()})`,
    ],
    ['document_dispatches', `SELECT count(*) AS n FROM document_dispatches WHERE booking_id = ${B()}`],
  ];

  it('control: staff (no portal scope) sees every one of those rows, so the zero counts below are the policy and not an empty fixture', async () => {
    for (const [name, sql] of bookingTables()) {
      expect(await asStaff(sql), name).toBeGreaterThan(0);
    }
    expect(await asStaff(`SELECT count(*) AS n FROM generated_documents WHERE booking_id = ${B()}`)).toBeGreaterThanOrEqual(5);
  });

  it('broker (who sourced the booking) sees 0 rows in every booking-money table and dispatch table', async () => {
    for (const [name, sql] of bookingTables()) {
      expect(await asBroker(f.brokerAId, sql), name).toBe(0);
    }
  });

  it('broker sees none of the customer documents of its sourced booking, whatever the type', async () => {
    expect(await asBroker(f.brokerAId, `SELECT count(*) AS n FROM generated_documents WHERE booking_id = ${B()}`)).toBe(0);
    for (const t of ['RECEIPT', 'STATEMENT', 'DEMAND_LETTER', 'ALLOTMENT_LETTER', 'REMINDER_LETTER']) {
      expect(
        await asBroker(f.brokerAId, `SELECT count(*) AS n FROM generated_documents WHERE document_type = '${t}'`),
        t,
      ).toBe(0);
    }
  });

  it("broker sees exactly its own BROKER_STATEMENT rows and not another broker's", async () => {
    expect(await asBroker(f.brokerAId, `SELECT count(*) AS n FROM generated_documents`)).toBe(1);
    expect(
      await asBroker(f.brokerAId, `SELECT count(*) AS n FROM generated_documents WHERE id = '${f.docs.brokerAStatement}'`),
    ).toBe(1);
    expect(
      await asBroker(f.brokerAId, `SELECT count(*) AS n FROM generated_documents WHERE id = '${f.docs.brokerBStatement}'`),
    ).toBe(0);
  });

  it('broker still sees the booking it sourced (bookings policy is untouched; the dashboard needs it)', async () => {
    expect(await asBroker(f.brokerAId, `SELECT count(*) AS n FROM bookings WHERE id = ${B()}`)).toBe(1);
  });

  it('customer (primary) still sees every row in every one of those tables for their own booking', async () => {
    for (const [name, sql] of bookingTables()) {
      expect(await asCustomer(f.applicantId, sql), name).toBeGreaterThan(0);
    }
  });

  it('customer still sees all five document types of their booking at the database level (the allow-list is the service job)', async () => {
    for (const t of ['RECEIPT', 'STATEMENT', 'DEMAND_LETTER', 'ALLOTMENT_LETTER', 'REMINDER_LETTER']) {
      expect(
        await asCustomer(f.applicantId, `SELECT count(*) AS n FROM generated_documents WHERE document_type = '${t}' AND booking_id = ${B()}`),
        t,
      ).toBe(1);
    }
  });

  it('co-applicant still sees the booking rows and its documents', async () => {
    for (const [name, sql] of bookingTables()) {
      expect(await asCustomer(f.coApplicantId, sql), name).toBeGreaterThan(0);
    }
    expect(await asCustomer(f.coApplicantId, `SELECT count(*) AS n FROM generated_documents WHERE booking_id = ${B()}`)).toBeGreaterThanOrEqual(5);
  });

  it('customer sees no broker statement and none of another booking', async () => {
    expect(await asCustomer(f.applicantId, `SELECT count(*) AS n FROM generated_documents WHERE document_type = 'BROKER_STATEMENT'`)).toBe(0);
    expect(await asCustomer(f.applicantId, `SELECT count(*) AS n FROM generated_documents WHERE booking_id = '${f.otherBookingId}'`)).toBe(0);
  });

  it('unrelated customer sees nothing of this booking in any of those tables', async () => {
    for (const [name, sql] of bookingTables()) {
      expect(await asCustomer(f.unrelatedApplicantId, sql), name).toBe(0);
    }
  });
});
