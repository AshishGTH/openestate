/**
 * Follow-up timeline, site-visit specialization, and "my day" queue.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTenantPrismaClient, createSystemPrismaClient, runWithTenant, withTenantTx } from '@openestate/db';
import { SYSTEM_CLOCK, type Clock } from '@openestate/shared';
import { FollowUpService } from '../src/presales/follow-up.service';
import { CustomFieldsService } from '../src/custom-fields/custom-fields.service';
import { InquiryService } from '../src/presales/inquiry.service';
import { AssignmentService } from '../src/presales/assignment.service';
import { LeadStageTransitionService } from '../src/presales/lead-stage-transition.service';
import { InquiryDispositionTransitionService } from '../src/presales/inquiry-disposition-transition.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const shouldRun = !!(APP_URL && SYSTEM_URL);
const describeIf = shouldRun ? describe : describe.skip;

// Fixed, not SYSTEM_CLOCK, specifically for this file's own
// interactionAt-defaulting tests — a real wall-clock value would make
// "defaults to clock.now()" a flaky, time-of-run-dependent assertion.
const FIXED_NOW = new Date('2026-08-20T10:00:00.000Z');
const FIXED_CLOCK: Clock = { now: () => FIXED_NOW };

describeIf('Follow-ups: timeline, site visit, my day', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let followUpService: FollowUpService;
  let inquiryService: InquiryService;
  let companyId: string;
  let userId: string;

  beforeAll(async () => {
    tenantPrisma = createTenantPrismaClient(APP_URL!);
    systemPrisma = createSystemPrismaClient(SYSTEM_URL!);
    const assignmentService = new AssignmentService(tenantPrisma);
    inquiryService = new InquiryService(
      tenantPrisma,
      systemPrisma,
      SYSTEM_CLOCK,
      assignmentService,
      // applicantService is only reached from createFromLead(), which
      // this file never exercises — same as before v0.2.3, when this
      // call site already passed only four arguments.
      undefined as never,
      new CustomFieldsService(tenantPrisma, systemPrisma),
      new LeadStageTransitionService(),
      new InquiryDispositionTransitionService(),
    );
    followUpService = new FollowUpService(tenantPrisma, systemPrisma, FIXED_CLOCK, inquiryService);

    const company = await systemPrisma.company.create({
      data: { name: 'FollowUp Test Co', slug: `followup-test-${Date.now()}` },
    });
    companyId = company.id;
    const role = await systemPrisma.role.create({
      data: { companyId, name: 'Exec', slug: 'exec', isSystem: true },
    });
    const user = await systemPrisma.user.create({
      data: { companyId, email: `followup-${Date.now()}@test`, passwordHash: 'x', name: 'Exec', roleId: role.id },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await systemPrisma.followUp.deleteMany({ where: { companyId } });
    await systemPrisma.followUpType.deleteMany({ where: { companyId } });
    await systemPrisma.inquiryDispositionHistory.deleteMany({ where: { companyId } });
    await systemPrisma.inquiry.deleteMany({ where: { companyId } });
    await systemPrisma.applicant.deleteMany({ where: { companyId } });
    await systemPrisma.user.deleteMany({ where: { companyId } });
    await systemPrisma.role.deleteMany({ where: { companyId } });
    // This fixture never seeds lead stages itself — but under a
    // full-suite run, syncLeadStages' deliberately unscoped
    // company.findMany() (packages/db/prisma/sync-permissions.ts) can
    // race in and seed both a CompanyConfig row and 6 LeadStage rows for
    // this company too, if a sync test happens to run concurrently.
    // Delete both unconditionally so the company delete below never
    // depends on that race.
    await systemPrisma.leadStage.deleteMany({ where: { companyId } });
    await systemPrisma.dumpReason.deleteMany({ where: { companyId } });
    await systemPrisma.companyConfig.deleteMany({ where: { companyId } });
    await systemPrisma.company.delete({ where: { id: companyId } });
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('logs a site visit as a follow-up with scheduledAt/venue set', async () => {
    const inquiry = await inquiryService.create(companyId, {
      applicant: { name: 'Visit Lead', primaryPhone: '9876570001', alternatePhones: [] },
    });

    const siteVisitType = await runWithTenant({ companyId }, () =>
      withTenantTx(tenantPrisma, companyId, (tx: any) =>
        tx.followUpType.create({ data: { companyId, name: 'Site Visit' } }),
      ),
    );

    const followUp = await followUpService.create(
      companyId,
      inquiry.id,
      {
        typeId: siteVisitType.id,
        scheduledAt: new Date('2026-08-01T10:00:00.000Z'),
        venue: 'Sample Flat, Tower A',
        nextActionAt: new Date('2026-08-08T10:00:00.000Z'),
      },
      userId,
      { visibleUserIds: null },
    );

    expect(followUp.venue).toBe('Sample Flat, Tower A');
    expect(followUp.scheduledAt).not.toBeNull();

    const timeline = await followUpService.findAllForInquiry(companyId, inquiry.id, { visibleUserIds: null });
    expect(timeline).toHaveLength(1);
    expect(timeline[0].type.name).toBe('Site Visit');
  });

  it('"my day" surfaces today\'s and overdue follow-ups assigned to me, and excludes future ones', async () => {
    const overdueInquiry = await inquiryService.create(companyId, {
      applicant: { name: 'Overdue Lead', primaryPhone: '9876570002', alternatePhones: [] },
      nextFollowupAt: new Date(Date.now() - 86_400_000),
    });
    const futureInquiry = await inquiryService.create(companyId, {
      applicant: { name: 'Future Lead', primaryPhone: '9876570003', alternatePhones: [] },
      nextFollowupAt: new Date(Date.now() + 30 * 86_400_000),
    });

    await systemPrisma.inquiry.update({ where: { id: overdueInquiry.id }, data: { assignedToId: userId } });
    await systemPrisma.inquiry.update({ where: { id: futureInquiry.id }, data: { assignedToId: userId } });

    const myDay = await inquiryService.myDay(companyId, userId);
    const ids = myDay.map((i: { id: string }) => i.id);
    expect(ids).toContain(overdueInquiry.id);
    expect(ids).not.toContain(futureInquiry.id);
  });

  describe('nextActionAt required while the lead is active (SOP rule 2)', () => {
    it('refuses to log a follow-up on an OPEN inquiry with no nextActionAt', async () => {
      const inquiry = await inquiryService.create(companyId, {
        applicant: { name: 'No Next Date Lead', primaryPhone: '9876570004', alternatePhones: [] },
      });
      expect(inquiry.status).toBe('OPEN');

      await expect(
        followUpService.create(companyId, inquiry.id, { notes: 'Called, no next date set' }, userId, {
          visibleUserIds: null,
        }),
      ).rejects.toThrow(/next follow-up time is required/i);
    });

    it('allows a follow-up with no nextActionAt once the inquiry is terminal (DUMPED/SUCCESSFUL)', async () => {
      const inquiry = await inquiryService.create(companyId, {
        applicant: { name: 'Closed Lead', primaryPhone: '9876570005', alternatePhones: [] },
      });
      // Dump now requires a reason + remarks (SOP rule 5, item #2) — this
      // test is about nextActionAt's exemption once terminal, not about
      // that requirement, so it's satisfied here rather than worked around.
      const dumpReason = await systemPrisma.dumpReason.create({
        data: { companyId, name: 'Terminal FollowUp Test Reason', sortOrder: 0 },
      });
      await inquiryService.update(
        companyId,
        inquiry.id,
        { status: 'DUMPED', dumpReasonId: dumpReason.id, dumpRemarks: 'Closing this one out' },
        { visibleUserIds: null },
        userId,
      );

      const followUp = await followUpService.create(
        companyId,
        inquiry.id,
        { notes: 'Closing note, no further action' },
        userId,
        { visibleUserIds: null },
      );
      expect(followUp.id).toBeDefined();
    });

    it('succeeds and advances Inquiry.nextFollowupAt when nextActionAt is provided', async () => {
      const inquiry = await inquiryService.create(companyId, {
        applicant: { name: 'Scheduled Lead', primaryPhone: '9876570006', alternatePhones: [] },
      });
      const next = new Date('2026-09-01T09:00:00.000Z');

      await followUpService.create(companyId, inquiry.id, { notes: 'Will call back', nextActionAt: next }, userId, {
        visibleUserIds: null,
      });

      const updated = await systemPrisma.inquiry.findUnique({ where: { id: inquiry.id } });
      expect(updated.nextFollowupAt.toISOString()).toBe(next.toISOString());
    });
  });

  describe('interactionAt — distinct from createdAt and nextActionAt', () => {
    it('defaults to the injected Clock\'s now() when omitted', async () => {
      const inquiry = await inquiryService.create(companyId, {
        applicant: { name: 'Default Interaction Time Lead', primaryPhone: '9876570007', alternatePhones: [] },
      });

      const followUp = await followUpService.create(
        companyId,
        inquiry.id,
        { notes: 'Just called', nextActionAt: new Date('2026-09-02T09:00:00.000Z') },
        userId,
        { visibleUserIds: null },
      );

      expect(new Date(followUp.interactionAt).toISOString()).toBe(FIXED_NOW.toISOString());
    });

    it('accepts a backdated interactionAt so a call from yesterday can be logged today', async () => {
      const inquiry = await inquiryService.create(companyId, {
        applicant: { name: 'Backdated Call Lead', primaryPhone: '9876570008', alternatePhones: [] },
      });
      const yesterday = new Date(FIXED_NOW.getTime() - 86_400_000);

      const followUp = await followUpService.create(
        companyId,
        inquiry.id,
        {
          notes: 'Logging yesterday\'s call, forgot to save it then',
          interactionAt: yesterday,
          nextActionAt: new Date('2026-09-03T09:00:00.000Z'),
        },
        userId,
        { visibleUserIds: null },
      );

      expect(new Date(followUp.interactionAt).toISOString()).toBe(yesterday.toISOString());
      // Distinct from createdAt, which is always "now" (row-insert time) —
      // the whole point of this column existing.
      expect(new Date(followUp.createdAt).getTime()).not.toBe(yesterday.getTime());
    });
  });
});
