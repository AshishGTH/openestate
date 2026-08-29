/**
 * Escalation job: eligibility correctness and per-company isolation.
 * The scheduler tick uses the system client ONLY to enumerate companies;
 * all inquiry-row access for a given company happens inside
 * `runForCompany`, scoped by `runWithTenant` + RLS.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM + Redis.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { createTenantPrismaClient, createSystemPrismaClient, runWithTenant, withTenantTx } from '@openestate/db';
import type { Clock } from '@openestate/shared';
import { EscalationService } from '../src/presales/escalation.service';
import type { CommunicationProvider, CommunicationSendResult, CommunicationMessage } from '../src/queues/communication-provider';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const REDIS_TEST_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';
const shouldRun = !!(APP_URL && SYSTEM_URL);
const describeIf = shouldRun ? describe : describe.skip;

const NOW = new Date('2026-07-21T12:00:00.000Z');
const frozenClock: Clock = { now: () => NOW };

class RecordingProvider implements CommunicationProvider {
  sent: CommunicationMessage[] = [];
  async send(message: CommunicationMessage): Promise<CommunicationSendResult> {
    this.sent.push(message);
    return { success: true, providerMessageId: 'test-id' };
  }
}

describeIf('Escalation job', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let escalationQueue: Queue;
  let provider: RecordingProvider;
  let escalationService: EscalationService;

  let companyAId: string;
  let companyBId: string;
  let applicantAId: string;
  let applicantBId: string;
  let managerAId: string;

  beforeAll(async () => {
    tenantPrisma = createTenantPrismaClient(APP_URL!);
    systemPrisma = createSystemPrismaClient(SYSTEM_URL!);
    const connection = new Redis(REDIS_TEST_URL, { maxRetriesPerRequest: null });
    escalationQueue = new Queue('escalation-test', { connection });
    provider = new RecordingProvider();
    escalationService = new EscalationService(
      tenantPrisma,
      systemPrisma,
      frozenClock,
      provider,
      escalationQueue,
    );

    const companyA = await systemPrisma.company.create({
      data: { name: 'Escalation A', slug: `esc-a-${Date.now()}`, isActive: true },
    });
    const companyB = await systemPrisma.company.create({
      data: { name: 'Escalation B', slug: `esc-b-${Date.now()}`, isActive: true },
    });
    companyAId = companyA.id;
    companyBId = companyB.id;

    const roleA = await systemPrisma.role.create({
      data: { companyId: companyAId, name: 'Manager', slug: 'sales_manager', isSystem: true },
    });
    const roleB = await systemPrisma.role.create({
      data: { companyId: companyBId, name: 'Manager', slug: 'sales_manager', isSystem: true },
    });
    const managerA = await systemPrisma.user.create({
      data: { companyId: companyAId, email: `mgr-a-${Date.now()}@test`, passwordHash: 'x', name: 'Manager A', roleId: roleA.id },
    });
    await systemPrisma.user.create({
      data: { companyId: companyBId, email: `mgr-b-${Date.now()}@test`, passwordHash: 'x', name: 'Manager B', roleId: roleB.id },
    });
    managerAId = managerA.id;

    const applicantA = await systemPrisma.applicant.create({
      data: { companyId: companyAId, name: 'Applicant A', primaryPhone: '9876550001', primaryPhoneNormalized: '9876550001' },
    });
    const applicantB = await systemPrisma.applicant.create({
      data: { companyId: companyBId, name: 'Applicant B', primaryPhone: '9876550002', primaryPhoneNormalized: '9876550002' },
    });
    applicantAId = applicantA.id;
    applicantBId = applicantB.id;
  });

  afterAll(async () => {
    await escalationQueue.obliterate({ force: true }).catch(() => {});
    await escalationQueue.close();
    await systemPrisma.inquiry.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.applicant.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.user.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.role.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    // This fixture never seeds lead stages itself — but under a
    // full-suite run, syncLeadStages' deliberately unscoped
    // company.findMany() (packages/db/prisma/sync-permissions.ts) can
    // race in and seed both a CompanyConfig row and 6 LeadStage rows for
    // these companies too, if a sync test happens to run concurrently.
    // Delete both unconditionally so the company delete below never
    // depends on that race.
    await systemPrisma.leadStage.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.companyConfig.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.company.deleteMany({ where: { id: { in: [companyAId, companyBId] } } });
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('identifies overdue, not-yet-escalated inquiries correctly and ignores future/not-yet-overdue ones', async () => {
    const overdue = await runWithTenant({ companyId: companyAId }, () =>
      withTenantTx(tenantPrisma, companyAId, (tx: any) =>
        tx.inquiry.create({
          data: { companyId: companyAId, applicantId: applicantAId, status: 'OPEN', nextFollowupAt: new Date(NOW.getTime() - 86_400_000) },
        }),
      ),
    );
    const notOverdue = await runWithTenant({ companyId: companyAId }, () =>
      withTenantTx(tenantPrisma, companyAId, (tx: any) =>
        tx.inquiry.create({
          data: { companyId: companyAId, applicantId: applicantAId, status: 'OPEN', nextFollowupAt: new Date(NOW.getTime() + 86_400_000) },
        }),
      ),
    );
    const alreadyEscalated = await runWithTenant({ companyId: companyAId }, () =>
      withTenantTx(tenantPrisma, companyAId, (tx: any) =>
        tx.inquiry.create({
          data: {
            companyId: companyAId,
            applicantId: applicantAId,
            status: 'OPEN',
            nextFollowupAt: new Date(NOW.getTime() - 86_400_000),
            lastEscalatedAt: NOW, // escalated at "now", after the overdue date -> not re-eligible
          },
        }),
      ),
    );

    const result = await escalationService.runForCompany(companyAId);

    expect(result.escalatedInquiryIds).toContain(overdue.id);
    expect(result.escalatedInquiryIds).not.toContain(notOverdue.id);
    expect(result.escalatedInquiryIds).not.toContain(alreadyEscalated.id);
    expect(result.notifiedUserIds).toContain(managerAId);
    expect(provider.sent.some((m) => m.toAddress.includes('@'))).toBe(true);

    const updated = await systemPrisma.inquiry.findUnique({ where: { id: overdue.id } });
    expect(updated.lastEscalatedAt).not.toBeNull();
  });

  it('per-company isolation: running for company A never touches company B rows, even without an explicit filter inside the tenant tx (RLS enforced)', async () => {
    await runWithTenant({ companyId: companyBId }, () =>
      withTenantTx(tenantPrisma, companyBId, (tx: any) =>
        tx.inquiry.create({
          data: { companyId: companyBId, applicantId: applicantBId, status: 'OPEN', nextFollowupAt: new Date(NOW.getTime() - 86_400_000) },
        }),
      ),
    );

    // Prove RLS itself restricts visibility: a raw, filter-less SELECT
    // inside company A's tenant tx must not see company B's overdue row.
    const rawCountInsideA = await runWithTenant({ companyId: companyAId }, () =>
      withTenantTx(tenantPrisma, companyAId, async (tx: any) => {
        const rows = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM inquiries WHERE next_followup_at < ${NOW}`;
        return Number(rows[0].n);
      }),
    );
    const rawCountInsideB = await runWithTenant({ companyId: companyBId }, () =>
      withTenantTx(tenantPrisma, companyBId, async (tx: any) => {
        const rows = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM inquiries WHERE next_followup_at < ${NOW}`;
        return Number(rows[0].n);
      }),
    );
    expect(rawCountInsideB).toBeGreaterThan(0);
    // Company A's session cannot see company B's row regardless of the
    // (missing) company_id predicate.
    const bIdsViaSystem = await systemPrisma.inquiry.findMany({ where: { companyId: companyBId } });
    for (const row of bIdsViaSystem) {
      const leaked = await runWithTenant({ companyId: companyAId }, () =>
        withTenantTx(tenantPrisma, companyAId, async (tx: any) => {
          const rows = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM inquiries WHERE id = ${row.id}::uuid`;
          return Number(rows[0].n);
        }),
      );
      expect(leaked).toBe(0);
    }
    void rawCountInsideA;
  });

  it('dispatchTick enumerates active companies via the system client (id-only) and enqueues one job per company', async () => {
    const dispatched = await escalationService.dispatchTick();
    expect(dispatched).toContain(companyAId);
    expect(dispatched).toContain(companyBId);

    const waiting = await escalationQueue.getJobs(['waiting', 'delayed', 'active', 'completed'], 0, 100);
    const companyEscalationJobs = waiting.filter((j) => j.name === 'company-escalation');
    const jobCompanyIds = companyEscalationJobs.map((j) => j.data.companyId);
    expect(jobCompanyIds).toContain(companyAId);
    expect(jobCompanyIds).toContain(companyBId);
  });
});
