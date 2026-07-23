/**
 * Phase 6: portal RLS is the PRIMARY IDOR defense (see CLAUDE.md Phase 6
 * decisions) — these tests hit the database through a raw connection, the
 * same discipline Phase 3's escalation-isolation test and Phase 4/5's RLS
 * tests established for cross-company isolation, extended here to
 * cross-applicant/cross-broker isolation within a single company.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { firstValueFrom, Observable } from 'rxjs';
import { runWithTenant, withTenantTx } from '@openestate/db';
import { TenantContextInterceptor } from '../src/auth/interceptors/tenant-context.interceptor';
import {
  makeClients,
  seedCompany,
  makeUnit,
  makeApplicant,
  makeBroker,
  cleanupCompany,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

interface CountRow {
  n: bigint;
}

describeIf('Phase 6 portal RLS (IDOR, GUC hygiene, performance)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;

  // Applicant A is the "attacker" portal session in every IDOR test below.
  let applicantA: string;
  let applicantB: string;
  let applicantC: string; // co-applicant with A on bookingA — positive carve-out case
  let bookingAId: string;
  let bookingBId: string;
  let brokerA: string;
  let brokerB: string;

  async function makeBooking(applicantId: string, unitId: string, bookingNumber: string) {
    const b = await systemPrisma.booking.create({
      data: {
        companyId: fx.companyId,
        unitId,
        primaryApplicantId: applicantId,
        bookingNumber,
        agreedPricePaise: BigInt(20_00_000_00),
        bookingDate: new Date('2026-06-01'),
      },
    });
    return b.id as string;
  }

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    applicantA = await makeApplicant(systemPrisma, fx.companyId);
    applicantB = await makeApplicant(systemPrisma, fx.companyId);
    applicantC = await makeApplicant(systemPrisma, fx.companyId);
    brokerA = await makeBroker(systemPrisma, fx.companyId);
    brokerB = await makeBroker(systemPrisma, fx.companyId);

    const unitA = await makeUnit(systemPrisma, fx);
    const unitB = await makeUnit(systemPrisma, fx);
    bookingAId = await makeBooking(applicantA, unitA, `PORTAL-A-${Date.now()}`);
    bookingBId = await makeBooking(applicantB, unitB, `PORTAL-B-${Date.now()}`);

    await systemPrisma.bookingCoApplicant.create({
      data: { companyId: fx.companyId, bookingId: bookingAId, applicantId: applicantC },
    });

    await systemPrisma.commissionLedgerEntry.create({
      data: {
        companyId: fx.companyId,
        brokerId: brokerA,
        bookingId: bookingAId,
        entryType: 'ACCRUAL',
        signedAmountPaise: BigInt(50_000_00),
        effectiveDate: new Date('2026-06-01'),
      },
    });
    await systemPrisma.commissionLedgerEntry.create({
      data: {
        companyId: fx.companyId,
        brokerId: brokerB,
        bookingId: bookingBId,
        entryType: 'ACCRUAL',
        signedAmountPaise: BigInt(50_000_00),
        effectiveDate: new Date('2026-06-01'),
      },
    });
  });

  afterAll(async () => {
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

  async function countAsPortalBroker(brokerId: string, sql: string): Promise<number> {
    return runWithTenant({ companyId: fx.companyId, portalBrokerId: brokerId }, () =>
      withTenantTx(tenantPrisma, fx.companyId, async (tx) => {
        const rows = await (tx as { $queryRawUnsafe: (q: string) => Promise<CountRow[]> }).$queryRawUnsafe(sql);
        return Number(rows[0].n);
      }),
    );
  }

  it('IDOR 1: customer A guessing customer B\'s booking id gets 0 rows via a raw connection', async () => {
    const n = await countAsPortalApplicant(
      applicantA,
      `SELECT count(*)::bigint AS n FROM bookings WHERE id = '${bookingBId}'`,
    );
    expect(n).toBe(0);
  });

  it('IDOR 2: customer A guessing an unrelated applicant id gets 0 rows; a real co-applicant returns 1', async () => {
    const unrelated = await countAsPortalApplicant(
      applicantA,
      `SELECT count(*)::bigint AS n FROM applicants WHERE id = '${applicantB}'`,
    );
    expect(unrelated).toBe(0);

    const coApplicant = await countAsPortalApplicant(
      applicantA,
      `SELECT count(*)::bigint AS n FROM applicants WHERE id = '${applicantC}'`,
    );
    expect(coApplicant).toBe(1);
  });

  it('regression: bookings <-> booking_co_applicants recursion cycle (42P17) — both policies\' co-applicant branches return the correct rows, not just "no error"', async () => {
    // Primary applicant (A) reading their own booking exercises
    // bookings_portal_scope's direct-ownership branch, then reading the
    // co-applicant list on that same booking exercises
    // booking_co_applicants_portal_scope's "booking_id IN (SELECT ...
    // FROM bookings WHERE primary_applicant_id = ...)" branch — the edge
    // that queries bookings FROM booking_co_applicants' own policy.
    const aOwnBooking = await countAsPortalApplicant(
      applicantA,
      `SELECT count(*)::bigint AS n FROM bookings WHERE id = '${bookingAId}'`,
    );
    expect(aOwnBooking).toBe(1);

    const aCoApplicantRows = await countAsPortalApplicant(
      applicantA,
      `SELECT count(*)::bigint AS n FROM booking_co_applicants WHERE booking_id = '${bookingAId}'`,
    );
    expect(aCoApplicantRows).toBe(1); // the row linking C to bookingA

    // Co-applicant (C, not primary) reading the SAME booking exercises
    // bookings_portal_scope's co-applicant branch — booking_has_co_applicant(),
    // the edge that queries booking_co_applicants FROM bookings' own
    // policy. This is the other half of the former cycle.
    const cCanSeeBooking = await countAsPortalApplicant(
      applicantC,
      `SELECT count(*)::bigint AS n FROM bookings WHERE id = '${bookingAId}'`,
    );
    expect(cCanSeeBooking).toBe(1);

    const cOwnCoApplicantRow = await countAsPortalApplicant(
      applicantC,
      `SELECT count(*)::bigint AS n FROM booking_co_applicants WHERE booking_id = '${bookingAId}' AND applicant_id = '${applicantC}'`,
    );
    expect(cOwnCoApplicantRow).toBe(1);

    // An unrelated applicant (B) gets zero rows from both tables for this
    // booking — the recursion-breaking bypass must narrow, not widen.
    const bCannotSeeBooking = await countAsPortalApplicant(
      applicantB,
      `SELECT count(*)::bigint AS n FROM bookings WHERE id = '${bookingAId}'`,
    );
    expect(bCannotSeeBooking).toBe(0);

    const bCannotSeeCoApplicants = await countAsPortalApplicant(
      applicantB,
      `SELECT count(*)::bigint AS n FROM booking_co_applicants WHERE booking_id = '${bookingAId}'`,
    );
    expect(bCannotSeeCoApplicants).toBe(0);
  });

  it('IDOR 3: broker A guessing broker B\'s commission ledger entries gets 0 rows via a raw connection', async () => {
    const n = await countAsPortalBroker(
      brokerA,
      `SELECT count(*)::bigint AS n FROM commission_ledger_entries WHERE broker_id = '${brokerB}'`,
    );
    expect(n).toBe(0);
  });

  it('fail-safe direction: a stray portal_applicant_id GUC can only narrow access, never widen it', async () => {
    const staffCount = await runWithTenant({ companyId: fx.companyId }, () =>
      withTenantTx(tenantPrisma, fx.companyId, async (tx) => {
        const rows = await (tx as { $queryRawUnsafe: (q: string) => Promise<CountRow[]> }).$queryRawUnsafe(
          `SELECT count(*)::bigint AS n FROM applicants`,
        );
        return Number(rows[0].n);
      }),
    );
    expect(staffCount).toBeGreaterThanOrEqual(3); // at least A, B, C seeded above

    // Manually stray-set the portal GUC inside an otherwise staff-shaped
    // transaction (no portalApplicantId in the ambient store) — simulates
    // the GUC surviving on a pooled connection by accident.
    const strayCount = await runWithTenant({ companyId: fx.companyId }, () =>
      withTenantTx(tenantPrisma, fx.companyId, async (tx) => {
        await (tx as { $executeRawUnsafe: (q: string) => Promise<unknown> }).$executeRawUnsafe(
          `SELECT set_config('app.portal_applicant_id', '${applicantA}', true)`,
        );
        const rows = await (tx as { $queryRawUnsafe: (q: string) => Promise<CountRow[]> }).$queryRawUnsafe(
          `SELECT count(*)::bigint AS n FROM applicants`,
        );
        return Number(rows[0].n);
      }),
    );
    // Narrowed to applicant A's own visible set (self + co-applicant C),
    // never the full company count — a stray GUC under-fetches, it never
    // leaks wider access.
    expect(strayCount).toBeLessThan(staffCount);
    expect(strayCount).toBe(2);
  });

  /**
   * Proves TenantContextInterceptor's mechanism itself is sound GIVEN a
   * populated req.user — it does NOT prove req.user is actually populated
   * by the time a real request reaches it (that ordering question can only
   * be proven by a real HTTP request through the fully bootstrapped app;
   * see test/e2e-portal.test.ts).
   *
   * Deliberately exercises a real MODEL query (tx.applicant.findFirst)
   * inside a real withTenantTx()/prisma.$transaction() call — not a raw
   * $queryRawUnsafe. An earlier version of this test used raw SQL to read
   * back current_setting(), which passed even under a BROKEN mechanism
   * (a Guard calling AsyncLocalStorage.enterWith()): raw queries bypass
   * tenantExtension()'s $allOperations hook entirely, so that version
   * never actually proved what mattered. A debug trace against the real
   * bug showed tenantContext.getStore() was undefined by the time a model
   * query ran inside prisma.$transaction()'s callback, even though
   * enterWith() had been called moments earlier in the same request — see
   * CLAUDE.md Phase 6 commit 2 decisions. Routing the model query through
   * next.handle() inside runWithTenant() (what the interceptor actually
   * does) is what this test must reproduce to be a real proof.
   */
  it('TenantContextInterceptor establishes ambient context that survives into a real prisma.$transaction() model query', async () => {
    const interceptor = new TenantContextInterceptor();
    const req = {
      user: { sub: fx.userId, companyId: fx.companyId, email: null, roleSlug: 'admin', permissions: [] },
      ip: '127.0.0.1',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const context = { switchToHttp: () => ({ getRequest: () => req }) } as any;
    const handler = {
      handle: () =>
        new Observable((subscriber) => {
          withTenantTx(tenantPrisma, fx.companyId, (tx) => tx.applicant.findFirst({ where: { id: applicantA } }))
            .then((row) => {
              subscriber.next(row);
              subscriber.complete();
            })
            .catch((err) => subscriber.error(err));
        }),
    };

    const result = await firstValueFrom(interceptor.intercept(context, handler));

    expect((result as { id: string }).id).toBe(applicantA);
  });

  it('coarse RLS performance regression: ~200-row portal-scoped ledger read stays under 500ms', async () => {
    const rows = Array.from({ length: 200 }, () => ({
      companyId: fx.companyId,
      brokerId: brokerA,
      bookingId: bookingAId,
      entryType: 'ACCRUAL' as const,
      signedAmountPaise: BigInt(1000),
      effectiveDate: new Date('2026-06-15'),
    }));
    await systemPrisma.commissionLedgerEntry.createMany({ data: rows });

    const start = performance.now();
    const n = await countAsPortalBroker(
      brokerA,
      `SELECT count(*)::bigint AS n FROM commission_ledger_entries WHERE broker_id = '${brokerA}'`,
    );
    const elapsedMs = performance.now() - start;

    expect(n).toBeGreaterThanOrEqual(200);
    expect(elapsedMs).toBeLessThan(500);
  });
});
