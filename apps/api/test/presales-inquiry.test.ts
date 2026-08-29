/**
 * Inquiry role scoping (sales_executive sees only own queue) and
 * Excel import all-or-nothing behavior.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as ExcelJS from 'exceljs';
import { createTenantPrismaClient, createSystemPrismaClient } from '@openestate/db';
import { SYSTEM_CLOCK } from '@openestate/shared';
import { InquiryService } from '../src/presales/inquiry.service';
import { CustomFieldsService } from '../src/custom-fields/custom-fields.service';
import { AssignmentService } from '../src/presales/assignment.service';
import { InquiryImportService } from '../src/presales/inquiry-import.service';
import { LeadStageTransitionService } from '../src/presales/lead-stage-transition.service';
import { InquiryDispositionTransitionService } from '../src/presales/inquiry-disposition-transition.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const shouldRun = !!(APP_URL && SYSTEM_URL);
const describeIf = shouldRun ? describe : describe.skip;

describeIf('Inquiry role scoping and import', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let inquiryService: InquiryService;
  let importService: InquiryImportService;
  let companyId: string;
  let execAId: string;
  let execBId: string;

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
    // assignmentService/leadStageTransition were previously omitted here
    // entirely (assignmentService undefined) — this file's own rows never
    // carry a projectId, so autoAssign() was never reached. Passing the
    // already-constructed assignmentService now costs nothing and is more
    // correct; leadStageTransition is newly required (every row now
    // resolves/logs a stage, unconditionally, unlike assignment).
    importService = new InquiryImportService(tenantPrisma, assignmentService, new LeadStageTransitionService(), new InquiryDispositionTransitionService());

    const company = await systemPrisma.company.create({
      data: { name: 'Scope Test Co', slug: `scope-test-${Date.now()}` },
    });
    companyId = company.id;
    const role = await systemPrisma.role.create({
      data: { companyId, name: 'Exec', slug: 'exec', isSystem: true },
    });
    const execA = await systemPrisma.user.create({
      data: { companyId, email: `exec-a-${Date.now()}@test`, passwordHash: 'x', name: 'Exec A', roleId: role.id },
    });
    const execB = await systemPrisma.user.create({
      data: { companyId, email: `exec-b-${Date.now()}@test`, passwordHash: 'x', name: 'Exec B', roleId: role.id },
    });
    execAId = execA.id;
    execBId = execB.id;
  });

  afterAll(async () => {
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

  it('sales executive scope sees only their own assigned inquiries', async () => {
    const inqA = await inquiryService.create(companyId, {
      applicant: { name: 'Lead A', primaryPhone: '9876520001', alternatePhones: [] },
    });
    const inqB = await inquiryService.create(companyId, {
      applicant: { name: 'Lead B', primaryPhone: '9876520002', alternatePhones: [] },
    });

    await systemPrisma.inquiry.update({ where: { id: inqA.id }, data: { assignedToId: execAId } });
    await systemPrisma.inquiry.update({ where: { id: inqB.id }, data: { assignedToId: execBId } });

    const resultForA = await inquiryService.findAll(
      companyId,
      { page: 1, limit: 50, sortOrder: 'asc' },
      { visibleUserIds: [execAId] },
    );
    expect(resultForA.data.every((i: { id: string }) => i.id !== inqB.id)).toBe(true);
    expect(resultForA.data.some((i: { id: string }) => i.id === inqA.id)).toBe(true);

    const resultForManager = await inquiryService.findAll(
      companyId,
      { page: 1, limit: 50, sortOrder: 'asc' },
      { visibleUserIds: null },
    );
    const ids = resultForManager.data.map((i: { id: string }) => i.id);
    expect(ids).toContain(inqA.id);
    expect(ids).toContain(inqB.id);
  });

  it('sales executive cannot fetch a colleague\'s inquiry by ID when scoped', async () => {
    const inq = await inquiryService.create(companyId, {
      applicant: { name: 'Scoped Lead', primaryPhone: '9876520003', alternatePhones: [] },
    });
    await systemPrisma.inquiry.update({ where: { id: inq.id }, data: { assignedToId: execBId } });

    await expect(
      inquiryService.findOne(companyId, inq.id, { visibleUserIds: [execAId] }),
    ).rejects.toThrow();
  });

  describe('Excel import', () => {
    async function buildWorkbook(rows: Record<string, unknown>[]): Promise<Buffer> {
      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet('Inquiries');
      sheet.columns = [
        { header: 'Applicant Name', key: 'applicantName' },
        { header: 'Primary Phone', key: 'primaryPhone' },
        { header: 'Email', key: 'email' },
      ];
      for (const row of rows) sheet.addRow(row);
      const buf = await wb.xlsx.writeBuffer();
      return Buffer.from(buf);
    }

    it('creates rows and enumerates linked (duplicate) rows on success', async () => {
      const buffer = await buildWorkbook([
        { applicantName: 'Import One', primaryPhone: '9876530001' },
        { applicantName: 'Import Two', primaryPhone: '9876530002' },
      ]);
      const result = await importService.importInquiries(companyId, buffer);
      expect(result.success).toBe(true);
      expect(result.createdCount).toBe(2);
      expect(result.errorCount).toBe(0);

      // Re-import the same phone -> should link, not duplicate-create.
      const buffer2 = await buildWorkbook([
        { applicantName: 'Import One Again', primaryPhone: '9876530001' },
      ]);
      const result2 = await importService.importInquiries(companyId, buffer2);
      expect(result2.success).toBe(true);
      expect(result2.createdCount).toBe(1); // the inquiry itself is still created
      expect(result2.linkedCount).toBe(1); // but linked to the existing applicant
      expect(result2.linked[0].row).toBe(2);
    });

    it('is all-or-nothing: any row error means zero rows are created', async () => {
      const applicantsBefore = await systemPrisma.applicant.count({ where: { companyId } });

      const buffer = await buildWorkbook([
        { applicantName: 'Valid Row', primaryPhone: '9876530099' },
        { applicantName: '', primaryPhone: '9876530098' }, // invalid: empty name
      ]);
      const result = await importService.importInquiries(companyId, buffer);
      expect(result.success).toBe(false);
      expect(result.createdCount).toBe(0);
      expect(result.errorCount).toBeGreaterThan(0);
      expect(result.errors[0].row).toBe(3); // header + row1 valid + row2 invalid

      const applicantsAfter = await systemPrisma.applicant.count({ where: { companyId } });
      expect(applicantsAfter).toBe(applicantsBefore); // nothing committed
    });
  });
});
