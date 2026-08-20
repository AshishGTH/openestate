/**
 * Outcome-asserting coverage for the remaining LAND_BASED "coupling
 * sites" from plotted-farmhouse-inventory.md §13.1 (postsales-reports
 * .service.ts's rollups have their own tests in postsales-reports
 * .test.ts). Each of these used to traverse floor -> tower -> project,
 * which returns zero rows for a LAND_BASED unit (Unit.floorId is null);
 * every test here proves the fixed code path actually surfaces the
 * LAND_BASED row, not just that the query compiles — per the "assert
 * the OUTCOME, not the mechanism" standing rule.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as argon2 from '@node-rs/argon2';
import { runWithTenant } from '@openestate/db';
import { UnitService } from '../src/inventory/unit.service';
import { RateRevisionService } from '../src/inventory/rate-revision.service';
import { ProjectService } from '../src/inventory/project.service';
import { ImportExportService } from '../src/inventory/import-export.service';
import { ConstructionUpdateService } from '../src/customer-portal/construction-update.service';
import { NotificationService } from '../src/notifications/notification.service';
import { UploadService } from '../src/inventory/upload.service';
import { CustomFieldsService } from '../src/custom-fields/custom-fields.service';
import type { CommunicationProvider, CommunicationMessage, CommunicationSendResult } from '../src/queues/communication-provider';
import { makeClients, seedCompany, makeApplicant, makePortalRole, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

class RecordingProvider implements CommunicationProvider {
  sent: CommunicationMessage[] = [];
  async send(message: CommunicationMessage): Promise<CommunicationSendResult> {
    this.sent.push(message);
    return { success: true };
  }
}

describeIf('LAND_BASED coupling sites (plotted-farmhouse-inventory §13.1)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let units: UnitService;
  let rateRevisions: RateRevisionService;
  let projects: ProjectService;
  let importExport: ImportExportService;
  let constructionUpdates: ConstructionUpdateService;
  let recordingProvider: RecordingProvider;
  let fx: CompanyFixture;
  let landProjectId: string;
  let landUnitId: string;
  let landUnitNumber: string;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    const customFields = new CustomFieldsService(tenantPrisma, systemPrisma);
    units = new UnitService(tenantPrisma, systemPrisma, customFields);
    rateRevisions = new RateRevisionService(tenantPrisma, systemPrisma);
    projects = new ProjectService(tenantPrisma, systemPrisma, customFields);
    importExport = new ImportExportService(tenantPrisma, systemPrisma);
    recordingProvider = new RecordingProvider();
    constructionUpdates = new ConstructionUpdateService(
      tenantPrisma,
      systemPrisma,
      new UploadService(),
      new NotificationService(systemPrisma, recordingProvider),
    );
    fx = await seedCompany(systemPrisma);

    const landProject = await systemPrisma.project.create({
      data: { companyId: fx.companyId, name: 'Coupling Sites Land Project', code: `CSL-${Date.now()}`, shape: 'LAND_BASED' },
    });
    landProjectId = landProject.id;
    landUnitNumber = `PLOT-${Date.now()}`;
    const landUnit = await systemPrisma.unit.create({
      data: {
        companyId: fx.companyId,
        projectId: landProjectId,
        shape: 'LAND_BASED',
        floorId: null,
        number: landUnitNumber,
        status: 'AVAILABLE',
        baseRatePaise: BigInt(10_00_000_00),
      },
    });
    landUnitId = landUnit.id;
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('UnitService.findAll returns the LAND_BASED unit for its own project', async () => {
    const result = await units.findAll(fx.companyId, landProjectId, { page: 1, limit: 20 } as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.data.some((u: any) => u.id === landUnitId)).toBe(true);
  });

  it('RateRevisionService.changeRate accepts a LAND_BASED unit instead of 400ing "not found in project"', async () => {
    const result = await rateRevisions.changeRate(
      fx.companyId,
      landProjectId,
      {
        unitIds: [landUnitId],
        ratePaise: 12_00_000_00n,
        effectiveFrom: new Date('2026-01-01'),
        reason: 'LAND_BASED coupling-site regression test',
      },
      fx.userId,
    );
    expect(result).toBeDefined();
    const unit = await systemPrisma.unit.findUniqueOrThrow({ where: { id: landUnitId } });
    expect(unit.baseRatePaise).toBe(12_00_000_00n);
  });

  it('ProjectService.bookingCount counts a booking against a LAND_BASED unit', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    await systemPrisma.booking.create({
      data: {
        companyId: fx.companyId,
        unitId: landUnitId,
        primaryApplicantId: applicantId,
        bookingNumber: `CSL-BOOK-${Date.now()}`,
        agreedPricePaise: BigInt(12_00_000_00),
        bookingDate: new Date('2026-06-01'),
        status: 'BOOKED',
      },
    });
    const count = await projects.bookingCount(fx.companyId, landProjectId);
    expect(count).toBe(1);
  });

  it('ImportExportService.exportUnits includes the LAND_BASED unit in the workbook, not an empty export', async () => {
    const buffer = await importExport.exportUnits(fx.companyId, landProjectId);
    expect(buffer.length).toBeGreaterThan(0);
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const sheet = workbook.getWorksheet('Units')!;
    const unitNumbers: string[] = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      unitNumbers.push(String(row.getCell(5).value)); // column 5 = Unit Number
    });
    expect(unitNumbers).toContain(landUnitNumber);
  });

  it('ConstructionUpdateService.create notifies a LAND_BASED booking\'s applicant, not zero recipients', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const applicant = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicantId } });
    const customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    // CONSTRUCTION_UPDATE_PUBLISHED's default pref is {email:true, sms:false}
    // (packages/shared/src/portal.ts) — the user needs an email, not just a
    // phone, or NotificationService silently sends nothing (by design: no
    // channel enabled + no address is "no notification," not an error).
    const email = `land-notify-${Date.now()}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        applicantId,
        phone: applicant.primaryPhone,
        email,
        name: applicant.name,
        passwordHash: await argon2.hash('irrelevant', { algorithm: argon2.Algorithm.Argon2id }),
        roleId: customerRoleId,
        forcePasswordChange: false,
      },
    });
    await systemPrisma.booking.create({
      data: {
        companyId: fx.companyId,
        unitId: landUnitId,
        primaryApplicantId: applicantId,
        bookingNumber: `CSL-NOTIFY-${Date.now()}`,
        agreedPricePaise: BigInt(12_00_000_00),
        bookingDate: new Date('2026-06-01'),
        status: 'BOOKED',
      },
    });

    recordingProvider.sent = [];
    // ConstructionUpdateService.create() calls withTenantTx() directly
    // with no self-wrap (unlike RateRevisionService above) — it relies
    // on the real HTTP pipeline's TenantContextInterceptor to have
    // already established ambient tenant context. A direct-call test
    // has to provide that itself, same pattern as every other
    // direct-service test in this suite that hits a non-self-wrapping
    // service.
    await runWithTenant({ companyId: fx.companyId }, () =>
      constructionUpdates.create(fx.companyId, fx.userId, {
        projectId: landProjectId,
        title: 'Plot fencing complete',
        publishedAt: new Date('2026-06-15'),
      }),
    );

    expect(recordingProvider.sent.length).toBeGreaterThan(0);
    expect(recordingProvider.sent.some((m) => m.toAddress === email)).toBe(true);
  });
});
