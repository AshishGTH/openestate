/**
 * Phase 7 commit 3: `generic-sales` end-to-end (CLAUDE.md Phase 7
 * decisions §7) — install() applies the plugin's declarative
 * terminologyOverrides/enabledModules/customFieldSeeds through the SAME
 * CompanyService/CustomFieldsService calls a staff admin would make by
 * hand, and CompanyService.getTerminology() reflects the result
 * immediately after.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { plugin as genericSalesPlugin } from '@openestate/generic-sales';
import type { Plugin } from '@openestate/plugin-sdk';
import { SYSTEM_CLOCK } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { PluginRegistryService } from '../src/plugins/plugin-registry.service';
import { PluginRuntimeService } from '../src/plugins/plugin-runtime.service';
import { PluginSecretEncryptionService } from '../src/plugins/plugin-secret-encryption.service';
import { PluginAdminService } from '../src/plugins/plugin-admin.service';
import { ApplicantService } from '../src/presales/applicant.service';
import { PanEncryptionService } from '../src/common/pan-encryption.service';
import { CompanyService } from '../src/company/company.service';
import { CustomFieldsService } from '../src/custom-fields/custom-fields.service';
import { InquiryService } from '../src/presales/inquiry.service';
import { AssignmentService } from '../src/presales/assignment.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'d4e5f6a7'.repeat(8)}`;
process.env.PAN_ENCRYPTION_KEY ??= 'd4e5f6a7'.repeat(8);

describeIf('generic-sales plugin (Phase 7 commit 3)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let admin: PluginAdminService;
  let companyService: CompanyService;
  let registry: PluginRegistryService;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    registry = new PluginRegistryService([genericSalesPlugin as Plugin]);
    registry.onModuleInit();
    const applicantService = new ApplicantService(tenantPrisma, systemPrisma, new PanEncryptionService());
    companyService = new CompanyService(tenantPrisma, systemPrisma);
    const assignmentService = new AssignmentService(tenantPrisma);
    const inquiryService = new InquiryService(tenantPrisma, systemPrisma, SYSTEM_CLOCK, assignmentService, applicantService);
    const runtime = new PluginRuntimeService(new PluginSecretEncryptionService(), applicantService, companyService, inquiryService);
    const customFieldsService = new CustomFieldsService(tenantPrisma, systemPrisma);
    admin = new PluginAdminService(systemPrisma, registry, runtime, new PluginSecretEncryptionService(), companyService, customFieldsService);
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('registers as active (compatible coreApiVersion)', () => {
    const list = registry.listAll();
    expect(list.map((p: Plugin) => p.manifest.id)).toContain('generic-sales');
    expect(registry.getStatus('generic-sales')).toBe('active');
  });

  it('install() merges terminologyOverrides onto any pre-existing labelOverrides, never replacing them wholesale', async () => {
    // A staff admin had already set an unrelated override before installing the plugin.
    await companyService.updateConfig(fx.companyId, { labelOverrides: { follow_up: 'Check-in' } });

    await admin.install(fx.companyId, 'generic-sales', fx.userId);

    const config = await companyService.getConfig(fx.companyId);
    const overrides = config.labelOverrides as Record<string, string>;
    expect(overrides.follow_up).toBe('Check-in'); // preserved, not clobbered
    expect(overrides.unit).toBe('Product');
    expect(overrides.project).toBe('Catalog');
    expect(overrides.booking).toBe('Order');
    expect(overrides.inquiry).toBe('Lead');
  });

  it('install() sets enabledModules from the plugin manifest', async () => {
    const config = await companyService.getConfig(fx.companyId);
    expect(config.enabledModules).toEqual(['presales', 'postsales', 'accounts']);
  });

  it('install() creates the warranty_period_months custom field on APPLICANT', async () => {
    const field = await systemPrisma.customFieldDefinition.findFirst({
      where: { companyId: fx.companyId, entityType: 'APPLICANT', key: 'warranty_period_months' },
    });
    expect(field).toBeTruthy();
    expect(field.label).toBe('Warranty Period (months)');
    expect(field.fieldType).toBe('NUMBER');
  });

  it("CompanyService.getTerminology() reflects the plugin's overrides immediately after install", async () => {
    const terminology = await companyService.getTerminology(fx.companyId);
    expect(terminology.unit).toBe('Product');
    expect(terminology.booking).toBe('Order');
  });

  it('a re-install (after uninstall) does not error on the already-existing custom field — idempotent, not a duplicate-key crash', async () => {
    await admin.uninstall(fx.companyId, 'generic-sales');
    await expect(admin.install(fx.companyId, 'generic-sales', fx.userId)).resolves.toBeTruthy();

    const fields = await systemPrisma.customFieldDefinition.findMany({
      where: { companyId: fx.companyId, entityType: 'APPLICANT', key: 'warranty_period_months' },
    });
    expect(fields).toHaveLength(1); // never duplicated
  });
});
