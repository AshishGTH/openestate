/**
 * Phase 7 commit 1 (plugin-core): PluginAdminService against real
 * Postgres — secrets encrypted at rest, never returned by GET, and the
 * admin-service-level orphaned/version-mismatch behavior addendum A6
 * requires (extends plugin-registry.test.ts's registry-level coverage
 * up to the service admins actually call).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { Plugin } from '@openestate/plugin-sdk';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { ApplicantService } from '../src/presales/applicant.service';
import { CompanyService } from '../src/company/company.service';
import { PluginSecretEncryptionService } from '../src/plugins/plugin-secret-encryption.service';
import { PluginRuntimeService } from '../src/plugins/plugin-runtime.service';
import { PluginRegistryService } from '../src/plugins/plugin-registry.service';
import { PluginAdminService } from '../src/plugins/plugin-admin.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'e5f6a7b8'.repeat(8)}`;

function makePlugin(id: string, coreApiVersion: string, calls: string[]): Plugin {
  return {
    manifest: {
      id,
      name: `Plugin ${id}`,
      version: '1.0.0',
      kind: 'messaging',
      coreApiVersion,
      description: 'test fixture',
      configSchema: z.object({ apiKey: z.string(), senderId: z.string().optional() }).strict(),
      configFields: [
        { key: 'apiKey', label: 'API Key', type: 'password', required: true, secret: true },
        { key: 'senderId', label: 'Sender ID', type: 'text', required: false },
      ],
      capabilities: [],
    },
    hooks: {
      onInstall: async () => {
        calls.push('onInstall');
      },
      onEnable: async () => {
        calls.push('onEnable');
      },
      onDisable: async () => {
        calls.push('onDisable');
      },
      onConfigChange: async () => {
        calls.push('onConfigChange');
      },
      onUninstall: async () => {
        calls.push('onUninstall');
      },
    },
  };
}

describeIf('PluginAdminService (Phase 7 commit 1)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let runtime: PluginRuntimeService;
  let calls: string[];

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    runtime = new PluginRuntimeService(new PluginSecretEncryptionService(), new ApplicantService(tenantPrisma, systemPrisma), new CompanyService(tenantPrisma, systemPrisma));
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  function makeAdmin(plugins: Plugin[]) {
    const registry = new PluginRegistryService(plugins);
    registry.onModuleInit();
    const admin = new PluginAdminService(systemPrisma, registry, runtime, new PluginSecretEncryptionService());
    return { admin, registry };
  }

  // ── Secrets: encrypted at rest, never returned by GET ────────

  describe('secret handling', () => {
    let admin: PluginAdminService;

    beforeAll(async () => {
      calls = [];
      ({ admin } = makeAdmin([makePlugin('msg-secret', '^1.0.0', calls)]));
      await admin.install(fx.companyId, 'msg-secret', fx.userId);
    });

    it('onInstall fired on install()', () => {
      expect(calls).toContain('onInstall');
    });

    it('setConfig() rejects a body that fails the plugin\'s own configSchema', async () => {
      await expect(admin.setConfig(fx.companyId, 'msg-secret', { senderId: 'ACME' })).rejects.toThrow(/Invalid plugin config/);
    });

    it('setConfig() stores the secret encrypted — the raw DB column never contains the plaintext', async () => {
      await admin.setConfig(fx.companyId, 'msg-secret', { apiKey: 'top-secret-key-999', senderId: 'ACME' });

      const row = await systemPrisma.pluginInstallation.findUnique({
        where: { companyId_pluginId: { companyId: fx.companyId, pluginId: 'msg-secret' } },
      });
      expect(row.configCiphertext).toBeTruthy();
      expect(row.configCiphertext).not.toContain('top-secret-key-999');
      // Sanity: a non-secret value ALSO doesn't appear verbatim, since the
      // whole config object is encrypted as one opaque blob (§6) — not
      // just the secret field.
      expect(row.configCiphertext).not.toContain('ACME');
    });

    it('getDetail() never returns the secret field, even though it returns the non-secret one', async () => {
      const detail = await admin.getDetail(fx.companyId, 'msg-secret');
      expect(detail.config).not.toBeNull();
      expect(detail.config).not.toHaveProperty('apiKey');
      expect(detail.config?.senderId).toBe('ACME');
    });

    it('enable() invokes onEnable, then subsequent setConfig() invokes onConfigChange', async () => {
      await admin.enable(fx.companyId, 'msg-secret');
      expect(calls).toContain('onEnable');

      await admin.setConfig(fx.companyId, 'msg-secret', { apiKey: 'rotated-key', senderId: 'ACME2' });
      expect(calls).toContain('onConfigChange');
    });

    it('disable() then uninstall() invoke their hooks and remove the row', async () => {
      await admin.disable(fx.companyId, 'msg-secret');
      expect(calls).toContain('onDisable');
      await admin.uninstall(fx.companyId, 'msg-secret');
      expect(calls).toContain('onUninstall');

      const row = await systemPrisma.pluginInstallation.findUnique({
        where: { companyId_pluginId: { companyId: fx.companyId, pluginId: 'msg-secret' } },
      });
      expect(row).toBeNull();
    });
  });

  // ── Addendum A6: orphaned (never-registered) installation ────

  describe('orphaned installation (pluginId never registered)', () => {
    const ORPHAN_ID = 'ghost-plugin';

    beforeAll(async () => {
      await systemPrisma.pluginInstallation.create({
        data: { companyId: fx.companyId, pluginId: ORPHAN_ID, isEnabled: true, installedById: fx.userId },
      });
    });

    afterAll(async () => {
      await systemPrisma.pluginInstallation.deleteMany({ where: { companyId: fx.companyId, pluginId: ORPHAN_ID } });
    });

    it('list() surfaces it as not-found rather than silently omitting it', async () => {
      const { admin } = makeAdmin([]); // registry knows nothing at all
      const list = await admin.list(fx.companyId);
      const entry = list.find((p) => p.pluginId === ORPHAN_ID);
      expect(entry).toBeDefined();
      expect(entry?.status).toBe('not-found');
      expect(entry?.installed).toBe(true);
      expect(entry?.isEnabled).toBe(true);
    });

    it('getDetail() reports unavailable instead of 404ing (it WAS installed, just not runnable)', async () => {
      const { admin } = makeAdmin([]);
      const detail = await admin.getDetail(fx.companyId, ORPHAN_ID);
      expect(detail.status).toBe('not-found');
      expect(detail.installed).toBe(true);
      expect(detail.config).toBeNull();
    });

    it('getDetail() still 404s for a pluginId that is neither registered NOR ever installed', async () => {
      const { admin } = makeAdmin([]);
      await expect(admin.getDetail(fx.companyId, 'never-heard-of-this-one')).rejects.toThrow(NotFoundException);
    });

    it('enable() 409s with the "not available in this build" message', async () => {
      const { admin } = makeAdmin([]);
      await expect(admin.enable(fx.companyId, ORPHAN_ID)).rejects.toThrow(ConflictException);
      await expect(admin.enable(fx.companyId, ORPHAN_ID)).rejects.toThrow(/not available in this build/);
    });

    it('disable() still succeeds (no hooks fire, but the row updates) — an orphaned install must stay cleanable', async () => {
      const { admin } = makeAdmin([]);
      const result = await admin.disable(fx.companyId, ORPHAN_ID);
      expect(result).toEqual({ pluginId: ORPHAN_ID, isEnabled: false });
    });
  });

  // ── Addendum A6: registered but version-gate-failing ─────────

  describe('installed plugin whose coreApiVersion range fails the gate', () => {
    const MISMATCH_ID = 'stale-plugin';

    beforeAll(async () => {
      await systemPrisma.pluginInstallation.create({
        data: { companyId: fx.companyId, pluginId: MISMATCH_ID, isEnabled: true, installedById: fx.userId },
      });
    });

    afterAll(async () => {
      await systemPrisma.pluginInstallation.deleteMany({ where: { companyId: fx.companyId, pluginId: MISMATCH_ID } });
    });

    it('getDetail() reports version-mismatch with the specific required-range info', async () => {
      const localCalls: string[] = [];
      const { admin } = makeAdmin([makePlugin(MISMATCH_ID, '^99.0.0', localCalls)]);
      const detail = await admin.getDetail(fx.companyId, MISMATCH_ID);
      expect(detail.status).toBe('version-mismatch');
      expect(detail.versionMismatch).toMatchObject({ pluginId: MISMATCH_ID, requiredRange: '^99.0.0' });
    });

    it('enable() 409s naming the required range and running core version', async () => {
      const localCalls: string[] = [];
      const { admin } = makeAdmin([makePlugin(MISMATCH_ID, '^99.0.0', localCalls)]);
      await expect(admin.enable(fx.companyId, MISMATCH_ID)).rejects.toThrow(/requires core API \^99\.0\.0/);
    });
  });
});
