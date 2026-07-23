/**
 * RLS isolation on all 8 new Phase 5 tables, raw-connection style — same
 * pattern as postsales-rls.test.ts (Phase 4): a filter-less query inside
 * company A's tenant transaction must never see company B's rows.
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
import { NocService } from '../src/brokers/noc.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const L = (rupees: number) => BigInt(rupees) * 100n;

const PHASE5_TABLES = [
  'brokers', 'broker_bank_details', 'broker_commission_rules', 'broker_commission_slabs',
  'broker_booking_commissions', 'commission_ledger_entries', 'commission_payments', 'broker_nocs',
];

describeIf('Phase 5 broker/commission tenant isolation (RLS)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let rules: BrokerCommissionRuleService;
  let commission: CommissionService;
  let payments: CommissionPaymentService;
  let nocs: NocService;
  let fxA: CompanyFixture;
  let fxB: CompanyFixture;
  let brokerBId: string;

  async function populate(fx: CompanyFixture) {
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    await systemPrisma.brokerBankDetail.create({
      data: { companyId: fx.companyId, brokerId, accountHolder: 'Test', accountNumber: '12345', ifsc: 'TEST0001234', bankName: 'Test Bank' },
    });
    await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, 2);
    // A SLAB-type rule (unused for accrual math here) just to populate
    // broker_commission_slabs for the RLS check below.
    const slabRule = await systemPrisma.brokerCommissionRule.create({
      data: { companyId: fx.companyId, brokerId, commissionType: 'SLAB' },
    });
    await systemPrisma.brokerCommissionSlab.create({
      data: { companyId: fx.companyId, ruleId: slabRule.id, seq: 1, fromPaise: 0n, toPaise: null, ratePercent: 1 },
    });
    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      { unitId, primaryApplicantId: applicantId, coApplicantIds: [], bookingDate: new Date('2026-06-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(20_00_000) }] },
      fx.userId,
    );
    await systemPrisma.booking.update({ where: { id: booking.id }, data: { brokerId } });
    await commission.accrueForBooking(fx.companyId, booking.id, fx.userId);
    await payments.request(fx.companyId, { brokerId, amountPaise: L(1_000) }, fx.userId);
    await nocs.request(fx.companyId, booking.id, {}, fx.userId);
    return brokerId;
  }

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    rules = new BrokerCommissionRuleService(tenantPrisma, systemPrisma);
    commission = new CommissionService(tenantPrisma, systemPrisma, rules);
    payments = new CommissionPaymentService(tenantPrisma, systemPrisma, commission, new NotificationService(systemPrisma, new ConsoleCommunicationProvider()));
    nocs = new NocService(tenantPrisma, systemPrisma);
    fxA = await seedCompany(systemPrisma);
    fxB = await seedCompany(systemPrisma);
    await populate(fxA);
    brokerBId = await populate(fxB);
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fxA.companyId);
    await cleanupCompany(systemPrisma, fxB.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('company A cannot see company B brokers/commission entries even with a filter-less raw query', async () => {
    const brokerLeak = await runWithTenant({ companyId: fxA.companyId }, () =>
      withTenantTx(tenantPrisma, fxA.companyId, async (tx) => {
        const rows = await (tx as { $queryRawUnsafe: (q: string) => Promise<{ n: bigint }[]> }).$queryRawUnsafe(
          `SELECT count(*)::bigint AS n FROM brokers WHERE id = '${brokerBId}'`,
        );
        return Number(rows[0].n);
      }),
    );
    expect(brokerLeak).toBe(0);

    const ledgerLeak = await runWithTenant({ companyId: fxA.companyId }, () =>
      withTenantTx(tenantPrisma, fxA.companyId, async (tx) => {
        const rows = await (tx as { $queryRawUnsafe: (q: string) => Promise<{ n: bigint }[]> }).$queryRawUnsafe(
          `SELECT count(*)::bigint AS n FROM commission_ledger_entries WHERE broker_id = '${brokerBId}'`,
        );
        return Number(rows[0].n);
      }),
    );
    expect(ledgerLeak).toBe(0);
  });

  it.each(PHASE5_TABLES)('table %s is RLS-isolated (A + B counts never exceed the true total)', async (table) => {
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
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });
});
