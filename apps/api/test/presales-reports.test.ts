/**
 * Ageing bucket math against seeded fixtures with known dates, and funnel
 * report reconciliation against raw counts on ~200 seeded inquiries.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSystemPrismaClient } from '@openestate/db';
import type { Clock } from '@openestate/shared';
import { ReportsService } from '../src/presales/reports.service';
import { TeamScopeService } from '../src/team-scope/team-scope.service';

const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const shouldRun = !!SYSTEM_URL;
const describeIf = shouldRun ? describe : describe.skip;

const FROZEN_NOW = new Date('2026-07-21T12:00:00.000Z');
const frozenClock: Clock = { now: () => FROZEN_NOW };

function daysAgo(n: number): Date {
  return new Date(FROZEN_NOW.getTime() - n * 86_400_000);
}

describeIf('Presales reports: ageing buckets + funnel reconciliation', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let reportsService: ReportsService;
  let companyId: string;
  let applicantId: string;

  beforeAll(async () => {
    systemPrisma = createSystemPrismaClient(SYSTEM_URL!);
    // TeamScopeService is only used by managerWiseInteractions, not
    // exercised by this file's ageing/funnel assertions — same
    // undefined-not-exercised pattern this codebase already uses
    // elsewhere for a constructor dependency a given test file never
    // reaches (see CLAUDE.md's v0.2.3 custom-field-values entry).
    reportsService = new ReportsService(systemPrisma, frozenClock, undefined as never);

    const company = await systemPrisma.company.create({
      data: { name: 'Reports Test Co', slug: `reports-test-${Date.now()}` },
    });
    companyId = company.id;
    const applicant = await systemPrisma.applicant.create({
      data: { companyId, name: 'Shared Applicant', primaryPhone: '9876540000', primaryPhoneNormalized: '9876540000' },
    });
    applicantId = applicant.id;
  });

  afterAll(async () => {
    await systemPrisma.inquiry.deleteMany({ where: { companyId } });
    await systemPrisma.applicant.deleteMany({ where: { companyId } });
    // This fixture never seeds lead stages itself — but under a
    // full-suite run, syncLeadStages' deliberately unscoped
    // company.findMany() (packages/db/prisma/sync-permissions.ts) can
    // race in and seed both a CompanyConfig row and 6 LeadStage rows for
    // this company too, if a sync test happens to run concurrently.
    // Delete both unconditionally so the company delete below never
    // depends on that race.
    await systemPrisma.leadStage.deleteMany({ where: { companyId } });
    await systemPrisma.companyConfig.deleteMany({ where: { companyId } });
    await systemPrisma.company.delete({ where: { id: companyId } });
    await systemPrisma.$disconnect();
  });

  describe('ageing buckets', () => {
    it('buckets seeded inquiries correctly against a frozen clock', async () => {
      const fixtures = [
        { days: 3, expected: '0-7' },
        { days: 7, expected: '0-7' },
        { days: 8, expected: '8-30' },
        { days: 30, expected: '8-30' },
        { days: 31, expected: '31-90' },
        { days: 90, expected: '31-90' },
        { days: 91, expected: '90+' },
        { days: 400, expected: '90+' },
      ];

      // createdAt is set directly in create()'s own `data`, not patched
      // afterward via a raw `$executeRaw UPDATE`. That used to be
      // necessary-looking (createdAt has @default(now())), but Prisma
      // allows overriding a @default(now()) field at create time, and the
      // ORM path round-trips a JS Date exactly via Prisma's own query
      // engine — confirmed directly (0ms drift) against this project's
      // real infra, not assumed. The raw-SQL path does NOT round-trip
      // safely: $executeRaw's parameter binding goes through node-postgres
      // text protocol, which formats/parses a `timestamp without time
      // zone` value using the Postgres session's `timezone` GUC — on any
      // server whose timezone isn't UTC (this one: Asia/Kolkata, +5:30),
      // that silently shifted every written date by the session's UTC
      // offset. Confirmed by direct reproduction: a raw UPDATE writing
      // `2026-07-13T12:00:00.000Z` read back as `17:30:00.000Z` — a full
      // 5.5-hour corruption — which pushed the day=8 fixture's computed
      // age below the ageDays<=7 boundary and put a 3rd row in bucket
      // '0-7'. No production code hit this: every raw SQL call site that
      // touches a timestamp column uses Postgres's own now()/
      // clock_timestamp(), never a bound JS Date — this was the only
      // place in the codebase binding one into a timestamp column via
      // raw SQL, and grepping confirms no other test file did either.
      for (const f of fixtures) {
        await systemPrisma.inquiry.create({
          data: { companyId, applicantId, status: 'OPEN', createdAt: daysAgo(f.days) },
        });
      }

      const buckets = await reportsService.ageingBuckets(companyId, { visibleUserIds: null }, {});
      const byBucket = new Map(buckets.map((b: { bucket: string; count: number }) => [b.bucket, b.count]));

      expect(byBucket.get('0-7')).toBe(2);
      expect(byBucket.get('8-30')).toBe(2);
      expect(byBucket.get('31-90')).toBe(2);
      expect(byBucket.get('90+')).toBe(2);
    });
  });

  describe('funnel reconciliation on ~200 seeded inquiries', () => {
    const TOTAL = 200;
    const statusCycle = ['OPEN', 'CONTINUED', 'DUMPED', 'SUCCESSFUL'] as const;
    let funnelCompanyId: string;
    let funnelApplicantId: string;

    beforeAll(async () => {
      // Isolated company so this block's exact-count assertions can't be
      // polluted by the ageing-bucket fixtures created above.
      const company = await systemPrisma.company.create({
        data: { name: 'Funnel Test Co', slug: `funnel-test-${Date.now()}` },
      });
      funnelCompanyId = company.id;
      const applicant = await systemPrisma.applicant.create({
        data: {
          companyId: funnelCompanyId,
          name: 'Funnel Applicant',
          primaryPhone: '9876549999',
          primaryPhoneNormalized: '9876549999',
        },
      });
      funnelApplicantId = applicant.id;

      const rows = Array.from({ length: TOTAL }, (_, i) => ({
        companyId: funnelCompanyId,
        applicantId: funnelApplicantId,
        status: statusCycle[i % statusCycle.length],
      }));
      await systemPrisma.inquiry.createMany({ data: rows });
    });

    afterAll(async () => {
      await systemPrisma.inquiry.deleteMany({ where: { companyId: funnelCompanyId } });
      await systemPrisma.applicant.deleteMany({ where: { companyId: funnelCompanyId } });
      // See the outer afterAll's comment above — same syncLeadStages race.
      await systemPrisma.leadStage.deleteMany({ where: { companyId: funnelCompanyId } });
      await systemPrisma.companyConfig.deleteMany({ where: { companyId: funnelCompanyId } });
      await systemPrisma.company.delete({ where: { id: funnelCompanyId } });
    });

    it('funnel counts reconcile exactly against raw per-status counts', async () => {
      const funnel = await reportsService.funnelByStatus(funnelCompanyId, { visibleUserIds: null }, {});
      const funnelTotal = funnel.reduce((sum: number, r: { count: number }) => sum + r.count, 0);

      const rawTotal = await systemPrisma.inquiry.count({ where: { companyId: funnelCompanyId } });
      expect(funnelTotal).toBe(rawTotal);
      expect(rawTotal).toBe(TOTAL);

      for (const row of funnel) {
        const raw = await systemPrisma.inquiry.count({
          where: { companyId: funnelCompanyId, status: row.status },
        });
        expect(row.count).toBe(raw);
      }

      // Exact expected counts given the round-robin seed cycle.
      const expectedPerStatus = TOTAL / statusCycle.length;
      for (const status of statusCycle) {
        const raw = await systemPrisma.inquiry.count({ where: { companyId: funnelCompanyId, status } });
        expect(raw).toBe(expectedPerStatus);
      }
    });
  });
});

/**
 * Direct-service correctness for the v0.5 pre-sales reporting suite's new
 * methods, plus the required regression coverage for managerWiseInteractions
 * — which had ZERO test coverage before this fix (CLAUDE.md's reporting-suite
 * decisions: "verify it FIRES against the current managerWiseInteractions...
 * then fix, then confirm the guard goes green for the right reason").
 */
describeIf('Presales reports: new report methods (v0.5 reporting suite)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let reportsService: ReportsService;
  let companyId: string;
  let applicantId: string;

  beforeAll(async () => {
    systemPrisma = createSystemPrismaClient(SYSTEM_URL!);
    reportsService = new ReportsService(systemPrisma, frozenClock, new TeamScopeService(systemPrisma));

    const company = await systemPrisma.company.create({
      data: { name: 'New Reports Test Co', slug: `new-reports-test-${Date.now()}` },
    });
    companyId = company.id;
    const applicant = await systemPrisma.applicant.create({
      data: { companyId, name: 'New Reports Applicant', primaryPhone: '9876541111', primaryPhoneNormalized: '9876541111' },
    });
    applicantId = applicant.id;
  });

  afterAll(async () => {
    await systemPrisma.booking.deleteMany({ where: { companyId } });
    await systemPrisma.followUp.deleteMany({ where: { companyId } });
    await systemPrisma.inquiryStageHistory.deleteMany({ where: { companyId } });
    await systemPrisma.inquiryDispositionHistory.deleteMany({ where: { companyId } });
    await systemPrisma.inquiry.deleteMany({ where: { companyId } });
    await systemPrisma.applicant.deleteMany({ where: { companyId } });
    await systemPrisma.unit.deleteMany({ where: { companyId } });
    await systemPrisma.floor.deleteMany({ where: { companyId } });
    await systemPrisma.tower.deleteMany({ where: { companyId } });
    await systemPrisma.leadStage.deleteMany({ where: { companyId } });
    await systemPrisma.project.deleteMany({ where: { companyId } });
    await systemPrisma.user.deleteMany({ where: { companyId } });
    await systemPrisma.role.deleteMany({ where: { companyId } });
    await systemPrisma.companyConfig.deleteMany({ where: { companyId } });
    await systemPrisma.company.delete({ where: { id: companyId } });
    await systemPrisma.$disconnect();
  });

  it('managerWiseInteractions rolls up a manager\'s whole subtree via TeamScopeService — the bug the CI guard now catches', async () => {
    const managerRole = await systemPrisma.role.create({
      data: { companyId, name: 'Sales Manager', slug: 'sales_manager', isSystem: true },
    });
    const manager = await systemPrisma.user.create({
      data: { companyId, email: `mgr-${Date.now()}@test`, passwordHash: 'x', name: 'Manager One', roleId: managerRole.id },
    });
    const execRole = await systemPrisma.role.create({
      data: { companyId, name: 'Exec', slug: `exec-${Date.now()}`, isSystem: true },
    });
    const exec = await systemPrisma.user.create({
      data: {
        companyId,
        email: `exec-${Date.now()}@test`,
        passwordHash: 'x',
        name: 'Exec One',
        roleId: execRole.id,
        managerId: manager.id,
      },
    });
    const inquiry = await systemPrisma.inquiry.create({
      data: { companyId, applicantId, status: 'OPEN', assignedToId: exec.id },
    });
    // Logged by the SUBORDINATE, not the manager — the exact case the old
    // "each manager's own directly-logged interactions only" bug missed.
    await systemPrisma.followUp.createMany({
      data: [
        { companyId, inquiryId: inquiry.id, createdById: exec.id },
        { companyId, inquiryId: inquiry.id, createdById: exec.id },
      ],
    });

    const rows = await reportsService.managerWiseInteractions(companyId, { visibleUserIds: null }, {});
    const row = rows.find((r: { managerId: string }) => r.managerId === manager.id);
    expect(row).toBeDefined();
    expect(row!.interactionCount).toBe(2);
  });

  it('sourceWiseConversion shows status-based and booking-linked conversion side by side, never merged', async () => {
    // Inquiry A: marked SUCCESSFUL, but no booking ever attached — the
    // exact gap the user's explicit correction requires stays visible.
    const inqA = await systemPrisma.inquiry.create({
      data: { companyId, applicantId, status: 'SUCCESSFUL' },
    });
    // Inquiry B: has a real linked booking.
    const applicantB = await systemPrisma.applicant.create({
      data: { companyId, name: 'Booked Applicant', primaryPhone: '9876542222', primaryPhoneNormalized: '9876542222' },
    });
    const inqB = await systemPrisma.inquiry.create({
      data: { companyId, applicantId: applicantB.id, status: 'SUCCESSFUL' },
    });
    const project = await systemPrisma.project.create({
      data: { companyId, name: `Proj ${Date.now()}`, code: `PJ-${Date.now()}` },
    });
    const tower = await systemPrisma.tower.create({ data: { companyId, projectId: project.id, name: 'T', code: 'T' } });
    const floor = await systemPrisma.floor.create({ data: { companyId, towerId: tower.id, name: 'F1', floorNumber: 1 } });
    const unit = await systemPrisma.unit.create({
      data: { companyId, projectId: project.id, shape: 'HIGH_RISE', floorId: floor.id, number: `U-${Date.now()}`, status: 'AVAILABLE' },
    });
    await systemPrisma.booking.create({
      data: {
        companyId,
        unitId: unit.id,
        primaryApplicantId: applicantB.id,
        bookingNumber: `BKG-${Date.now()}`,
        agreedPricePaise: 1000000n,
        sourceInquiryId: inqB.id,
      },
    });

    const rows = await reportsService.sourceWiseConversion(companyId, { visibleUserIds: null }, {});
    const unknownSourceRow = rows.find((r: { sourceId: string }) => r.sourceId === 'unknown');
    expect(unknownSourceRow).toBeDefined();
    expect(unknownSourceRow!.total).toBe(2);
    expect(unknownSourceRow!.successful).toBe(2); // both marked SUCCESSFUL
    expect(unknownSourceRow!.bookingLinked).toBe(1); // only inqB has a real booking
    expect(unknownSourceRow!.conversionPercent).toBe(100);
    expect(unknownSourceRow!.bookingLinkedConversionPercent).toBe(50);

    await systemPrisma.inquiry.deleteMany({ where: { id: { in: [inqA.id, inqB.id] } } });
  });

  it('followUpOverdue counts only OPEN/CONTINUED inquiries whose nextFollowupAt is strictly in the past', async () => {
    const staffRole = await systemPrisma.role.create({
      data: { companyId, name: 'Staff', slug: `staff-${Date.now()}`, isSystem: true },
    });
    const staff = await systemPrisma.user.create({
      data: { companyId, email: `staff-${Date.now()}@test`, passwordHash: 'x', name: 'Staff One', roleId: staffRole.id },
    });
    const overdueInq = await systemPrisma.inquiry.create({
      data: { companyId, applicantId, status: 'OPEN', assignedToId: staff.id, nextFollowupAt: daysAgo(2) },
    });
    const futureInq = await systemPrisma.inquiry.create({
      data: {
        companyId,
        applicantId,
        status: 'OPEN',
        assignedToId: staff.id,
        nextFollowupAt: new Date(FROZEN_NOW.getTime() + 86_400_000),
      },
    });

    const rows = await reportsService.followUpOverdue(companyId, { visibleUserIds: null });
    const row = rows.find((r: { executiveId: string }) => r.executiveId === staff.id);
    expect(row).toBeDefined();
    expect(row!.overdueCount).toBe(1);

    await systemPrisma.inquiry.deleteMany({ where: { id: { in: [overdueInq.id, futureInq.id] } } });
  });

  it('stageTransitions and stageVelocity exclude administrative (bulk-reassignment) stage moves', async () => {
    const stageA = await systemPrisma.leadStage.create({ data: { companyId, name: `Stage A ${Date.now()}`, sortOrder: 1 } });
    const stageB = await systemPrisma.leadStage.create({ data: { companyId, name: `Stage B ${Date.now()}`, sortOrder: 2 } });
    const inquiry = await systemPrisma.inquiry.create({ data: { companyId, applicantId, status: 'OPEN', stageId: stageB.id } });

    const t0 = daysAgo(10);
    const t1 = daysAgo(5);
    await systemPrisma.inquiryStageHistory.create({
      data: { companyId, inquiryId: inquiry.id, fromStageId: null, toStageId: stageA.id, isAdministrative: false, changedAt: t0 },
    });
    await systemPrisma.inquiryStageHistory.create({
      data: { companyId, inquiryId: inquiry.id, fromStageId: stageA.id, toStageId: stageB.id, isAdministrative: false, changedAt: t1 },
    });
    // An administrative bulk-reassignment move — must not count toward
    // either report, or it would distort both the transition matrix and
    // the velocity average with a move nobody on the sales team made.
    const stageC = await systemPrisma.leadStage.create({ data: { companyId, name: `Stage C ${Date.now()}`, sortOrder: 3 } });
    await systemPrisma.inquiryStageHistory.create({
      data: { companyId, inquiryId: inquiry.id, fromStageId: stageB.id, toStageId: stageC.id, isAdministrative: true, changedAt: daysAgo(1) },
    });

    const transitions = await reportsService.stageTransitions(companyId, { visibleUserIds: null }, {});
    expect(transitions.find((t: { toStageName: string }) => t.toStageName === stageC.name)).toBeUndefined();
    const aToB = transitions.find((t: { fromStageName: string; toStageName: string }) => t.fromStageName === stageA.name && t.toStageName === stageB.name);
    expect(aToB).toBeDefined();
    expect(aToB!.count).toBe(1);

    const velocity = await reportsService.stageVelocity(companyId, { visibleUserIds: null }, {});
    const stageARow = velocity.find((v: { stageName: string }) => v.stageName === stageA.name);
    expect(stageARow).toBeDefined();
    // t0 -> t1 is exactly 5 days; the administrative move into stageC must
    // not appear as a closed stay for stageB at all.
    expect(stageARow!.avgDays).toBe(5);
    expect(velocity.find((v: { stageName: string }) => v.stageName === stageB.name)).toBeUndefined();

    await systemPrisma.inquiryStageHistory.deleteMany({ where: { inquiryId: inquiry.id } });
    await systemPrisma.inquiry.delete({ where: { id: inquiry.id } });
    await systemPrisma.leadStage.deleteMany({ where: { id: { in: [stageA.id, stageB.id, stageC.id] } } });
  });
});
