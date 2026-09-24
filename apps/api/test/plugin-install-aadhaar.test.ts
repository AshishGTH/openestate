/**
 * v0.8.0: the Aadhaar name guard (layer a) on the PLUGIN INSTALL path.
 *
 * PluginAdminService.install() applies a plugin's customFieldSeeds through
 * CustomFieldsService.create() — which now refuses an Aadhaar-named field.
 * But install() creates the installation row and applies the plugin's
 * terminology overrides and module list BEFORE it reaches the seeds, so a
 * rejection at that point would leave a half-installed plugin: an
 * installation row and changed company settings, with no custom field.
 * install() therefore checks every seed up front.
 *
 * Plugins are registered through a DI array (nothing loads them over
 * HTTP), so this constructs the services directly, like generic-sales.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
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
import { LeadStageTransitionService } from '../src/presales/lead-stage-transition.service';
import { InquiryDispositionTransitionService } from '../src/presales/inquiry-disposition-transition.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'d4e5f6a7'.repeat(8)}`;
process.env.PAN_ENCRYPTION_KEY ??= 'd4e5f6a7'.repeat(8);

type Seed = { key: string; label: string };

function fixturePlugin(id: string, seeds: Seed[]): Plugin {
  return {
    manifest: {
      id, name: id, version: '1.0.0', kind: 'vertical', coreApiVersion: '^1.0.0', description: 'test',
      configSchema: z.object({}), configFields: [], capabilities: [],
    },
    hooks: {
      terminologyOverrides: { unit: 'Widget' },
      enabledModules: ['presales'],
      customFieldSeeds: seeds.map((s) => ({ entityType: 'APPLICANT', fieldType: 'TEXT', isRequired: false, ...s })),
    },
  } as unknown as Plugin;
}

describeIf('plugin install: the Aadhaar name guard', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let admin: PluginAdminService;
  let companyService: CompanyService;
  const TAG = Date.now();

  const byKeyword = fixturePlugin(`bad-key-${TAG}`, [{ key: 'aadhaar_ref', label: 'Reference' }]);
  const byLabel = fixturePlugin(`bad-label-${TAG}`, [{ key: `id_no_${TAG}`, label: 'Adhaar No' }]);
  const mixed = fixturePlugin(`mixed-${TAG}`, [
    { key: `fine_${TAG}`, label: 'Fine field' },
    { key: `aadhar_${TAG}`, label: 'Second seed is the bad one' },
  ]);
  const clean = fixturePlugin(`clean-${TAG}`, [
    { key: 'uid', label: 'UID' },
    { key: `guide_${TAG}`, label: 'Guide' },
  ]);

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    const registry = new PluginRegistryService([byKeyword, byLabel, mixed, clean]);
    registry.onModuleInit();
    const customFields = new CustomFieldsService(tenantPrisma, systemPrisma);
    const applicants = new ApplicantService(tenantPrisma, systemPrisma, new PanEncryptionService(), customFields);
    companyService = new CompanyService(tenantPrisma, systemPrisma);
    const inquiries = new InquiryService(
      tenantPrisma, systemPrisma, SYSTEM_CLOCK, new AssignmentService(tenantPrisma), applicants, customFields,
      new LeadStageTransitionService(), new InquiryDispositionTransitionService(),
    );
    const runtime = new PluginRuntimeService(new PluginSecretEncryptionService(), applicants, companyService, inquiries);
    admin = new PluginAdminService(systemPrisma, registry, runtime, new PluginSecretEncryptionService(), companyService, customFields);
  });

  afterAll(async () => {
    await systemPrisma.pluginInstallation.deleteMany({ where: { companyId: fx.companyId } });
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  /** Everything install() could have written for a rejected plugin. */
  async function leftBehind(pluginId: string) {
    const config = await companyService.getConfig(fx.companyId);
    return {
      installations: await systemPrisma.pluginInstallation.count({ where: { companyId: fx.companyId, pluginId } }),
      definitions: await systemPrisma.customFieldDefinition.count({ where: { companyId: fx.companyId } }),
      unitLabel: (config.labelOverrides as Record<string, string> | null)?.unit,
    };
  }

  it.each([
    ['a seed keyed with an Aadhaar word', byKeyword, /"aadhaar"/],
    ['a seed labelled with an Aadhaar word', byLabel, /"adhaar"/],
    ['a bad seed that comes after a fine one', mixed, /"aadhar"/],
  ])('rejects %s, and leaves NOTHING behind: no installation row, no field, no settings change', async (_name, plugin, message) => {
    await expect(admin.install(fx.companyId, plugin.manifest.id, fx.userId)).rejects.toThrow(message);
    expect(await leftBehind(plugin.manifest.id)).toEqual({ installations: 0, definitions: 0, unitLabel: undefined });
  });

  it('a plugin whose seeds are only "uid" and "guide" installs, and its fields exist', async () => {
    await admin.install(fx.companyId, clean.manifest.id, fx.userId);
    const after = await leftBehind(clean.manifest.id);
    expect(after).toEqual({ installations: 1, definitions: 2, unitLabel: 'Widget' });
    const keys = (await systemPrisma.customFieldDefinition.findMany({ where: { companyId: fx.companyId } })).map((d: { key: string }) => d.key);
    expect(keys).toContain('uid');
  });
});
