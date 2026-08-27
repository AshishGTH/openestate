/**
 * Follow-up timeline, site-visit specialization, and "my day" queue.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTenantPrismaClient, createSystemPrismaClient, runWithTenant, withTenantTx } from '@openestate/db';
import { SYSTEM_CLOCK } from '@openestate/shared';
import { FollowUpService } from '../src/presales/follow-up.service';
import { CustomFieldsService } from '../src/custom-fields/custom-fields.service';
import { InquiryService } from '../src/presales/inquiry.service';
import { AssignmentService } from '../src/presales/assignment.service';
import { LeadStageTransitionService } from '../src/presales/lead-stage-transition.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const shouldRun = !!(APP_URL && SYSTEM_URL);
const describeIf = shouldRun ? describe : describe.skip;

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
    );
    followUpService = new FollowUpService(tenantPrisma, systemPrisma, inquiryService);

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
});
