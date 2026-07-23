/**
 * BrokerReportsService: functional correctness of each report, plus
 * "Report role-scoping" (required test #8) — for these company-wide
 * rollups (no per-row ownership like sales_exec's bookings), the
 * meaningful role-scoping check is the ROLE_PERMISSIONS wiring itself
 * (which roles actually carry REPORTS_BROKER_VIEW) plus company-tenant
 * isolation, proven directly here rather than duplicating the generic
 * PermissionsGuard mechanism test in permissions-guard.test.ts.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SYSTEM_CLOCK, formatInr, PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import {
  makeClients,
  buildServices,
  seedCompany,
  makeUnit,
  makeApplicant,
  makeBroker,
  makeFlatCommissionRule,
  cleanupCompany,
  type Services,
  type CompanyFixture,
} from './helpers/postsales-harness';
import { BrokerCommissionRuleService } from '../src/brokers/broker-commission-rule.service';
import { CommissionService } from '../src/commission/commission.service';
import { CommissionPaymentService } from '../src/commission/commission-payment.service';
import { NotificationService } from '../src/notifications/notification.service';
import { ConsoleCommunicationProvider } from '../src/queues/communication-provider';
import { BrokerReportsService } from '../src/reports/broker-reports.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const L = (rupees: number) => BigInt(rupees) * 100n;

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe('Report role-scoping: REPORTS_BROKER_VIEW wiring (no DB needed)', () => {
  it('sales_manager and company_admin carry REPORTS_BROKER_VIEW; sales_executive does not', () => {
    expect(ROLE_PERMISSIONS[SYSTEM_ROLES.SALES_MANAGER]).toContain(PERMISSIONS.REPORTS_BROKER_VIEW);
    expect(ROLE_PERMISSIONS[SYSTEM_ROLES.COMPANY_ADMIN]).toContain(PERMISSIONS.REPORTS_BROKER_VIEW);
    expect(ROLE_PERMISSIONS[SYSTEM_ROLES.SALES_EXECUTIVE]).not.toContain(PERMISSIONS.REPORTS_BROKER_VIEW);
  });
});

describeIf('BrokerReportsService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let rules: BrokerCommissionRuleService;
  let commission: CommissionService;
  let payments: CommissionPaymentService;
  let reports: BrokerReportsService;
  let fxA: CompanyFixture;
  let fxB: CompanyFixture;
  let brokerAId: string;
  let bookingAId: string;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    rules = new BrokerCommissionRuleService(tenantPrisma, systemPrisma);
    commission = new CommissionService(tenantPrisma, systemPrisma, rules);
    payments = new CommissionPaymentService(tenantPrisma, systemPrisma, commission, new NotificationService(systemPrisma, new ConsoleCommunicationProvider()));
    reports = new BrokerReportsService(systemPrisma);
    fxA = await seedCompany(systemPrisma);
    fxB = await seedCompany(systemPrisma);

    brokerAId = await makeBroker(systemPrisma, fxA.companyId);
    await makeFlatCommissionRule(systemPrisma, fxA.companyId, brokerAId, 2);
    const unitId = await makeUnit(systemPrisma, fxA);
    const applicantId = await makeApplicant(systemPrisma, fxA.companyId);
    const booking = await svc.bookings.createBooking(
      fxA.companyId,
      { unitId, primaryApplicantId: applicantId, coApplicantIds: [], bookingDate: new Date('2026-06-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(20_00_000) }] },
      fxA.userId,
    );
    bookingAId = booking.id;
    await systemPrisma.booking.update({ where: { id: booking.id }, data: { brokerId: brokerAId } });
    await commission.accrueForBooking(fxA.companyId, booking.id, fxA.userId); // 2% of 20,00,000 = 40,000

    const request = await payments.request(fxA.companyId, { brokerId: brokerAId, amountPaise: L(15_000) }, fxA.userId);
    await payments.approve(fxA.companyId, request.id, fxA.userId);
    await payments.pay(fxA.companyId, request.id, { mode: 'NEFT', paymentDate: new Date('2026-07-01') }, fxA.userId);
    // No 194-H TdsRule fixtured for this company -> paid = 15,000 gross, no TDS.

    // Company B: a broker with nothing sold, to prove cross-tenant isolation.
    await makeBroker(systemPrisma, fxB.companyId);
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fxA.companyId);
    await cleanupCompany(systemPrisma, fxB.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('soldUnits lists the brokered booking with the broker name resolved', async () => {
    const rows = await collect(reports.soldUnits(fxA.companyId));
    expect(rows).toHaveLength(1);
    const [brokerName, bookingNumber, applicantName, unitNumber, price] = rows[0];
    expect(brokerName).not.toBe(brokerAId); // resolved to a name, not left as a raw id
    expect(typeof bookingNumber).toBe('string');
    expect(typeof applicantName).toBe('string');
    expect(typeof unitNumber).toBe('string');
    expect(price).toBe(formatInr(L(20_00_000)));
  });

  it('commissionSummary: accrued 40,000, paid 15,000, outstanding 25,000', async () => {
    const rows = await collect(reports.commissionSummary(fxA.companyId));
    expect(rows).toHaveLength(1);
    const [, accrued, paid, tds, clawedBack, outstanding] = rows[0];
    expect(accrued).toBe(formatInr(L(40_000)));
    expect(paid).toBe(formatInr(L(15_000)));
    expect(tds).toBe(formatInr(0n));
    expect(clawedBack).toBe(formatInr(0n));
    expect(outstanding).toBe(formatInr(L(25_000)));
  });

  it('dues lists only brokers with outstanding > 0 (company B\'s broker has none)', async () => {
    const rowsA = await collect(reports.dues(fxA.companyId));
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0][2]).toBe(formatInr(L(25_000)));

    const rowsB = await collect(reports.dues(fxB.companyId));
    expect(rowsB).toHaveLength(0); // company B's broker never accrued anything
  });

  it('customerDetail for the broker shows the one booking with accrued/paid/outstanding', async () => {
    const rows = await collect(reports.customerDetail(fxA.companyId, brokerAId));
    expect(rows).toHaveLength(1);
    const [applicantName, bookingNumber, unitNumber, price, accrued, paid, outstanding] = rows[0];
    expect(typeof applicantName).toBe('string');
    expect(typeof bookingNumber).toBe('string');
    expect(typeof unitNumber).toBe('string');
    expect(price).toBe(formatInr(L(20_00_000)));
    expect(accrued).toBe(formatInr(L(40_000)));
    expect(paid).toBe(formatInr(L(15_000)));
    expect(outstanding).toBe(formatInr(L(25_000)));
  });

  it('summary rolls up company-wide: 1 active broker (with sales), matching totals', async () => {
    const result = await reports.summary(fxA.companyId);
    expect(result.unitsSoldViaBroker).toBe(1);
    expect(result.totalCommissionAccruedFormatted).toBe(formatInr(L(40_000)));
    expect(result.totalCommissionPaidFormatted).toBe(formatInr(L(15_000)));
    expect(result.totalCommissionOutstandingFormatted).toBe(formatInr(L(25_000)));

    // Company B's broker never sourced a booking or accrued anything.
    const resultB = await reports.summary(fxB.companyId);
    expect(resultB.unitsSoldViaBroker).toBe(0);
    expect(resultB.totalCommissionAccruedFormatted).toBe(formatInr(0n));
  });

  it('company B never sees company A\'s broker/booking rows (tenant isolation)', async () => {
    const soldUnitsB = await collect(reports.soldUnits(fxB.companyId));
    expect(soldUnitsB).toHaveLength(0);
    const summaryB = await collect(reports.commissionSummary(fxB.companyId));
    expect(summaryB).toHaveLength(0);
    void bookingAId;
  });
});
