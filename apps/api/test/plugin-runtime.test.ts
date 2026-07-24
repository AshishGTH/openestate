/**
 * Phase 7 commit 1 (plugin-core): PluginRuntimeService — capability
 * isolation (Proxy denial), secret handling (SecretRef, never
 * plaintext in ctx.config), invoke()'s throw/timeout handling, and a
 * direct cross-check against Phase 6's runWithTenant guardrail (§2:
 * real plugins never get a reference to runWithTenant at all, so this
 * proves the guardrail itself still works as defense-in-depth, not that
 * a real plugin could ever reach it).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import { runWithTenant } from '@openestate/db';
import { isSecretRef, PluginCapabilityError, type Plugin } from '@openestate/plugin-sdk';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { ApplicantService } from '../src/presales/applicant.service';
import { PanEncryptionService } from '../src/common/pan-encryption.service';
import { CompanyService } from '../src/company/company.service';
import { PluginSecretEncryptionService } from '../src/plugins/plugin-secret-encryption.service';
import { PluginRuntimeService } from '../src/plugins/plugin-runtime.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'d1e2f3a4'.repeat(8)}`;
process.env.PAN_ENCRYPTION_KEY ??= 'c3d4e5f6'.repeat(8);

function makePlugin(capabilities: Plugin['manifest']['capabilities'], configFields: Plugin['manifest']['configFields'] = []): Plugin {
  return {
    manifest: {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      kind: 'messaging',
      coreApiVersion: '^1.0.0',
      description: 'test fixture',
      configSchema: z.record(z.string(), z.unknown()),
      configFields,
      capabilities,
    },
    hooks: {},
  };
}

describeIf('PluginRuntimeService (Phase 7 commit 1)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let runtime: PluginRuntimeService;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime = new PluginRuntimeService(new PluginSecretEncryptionService(), new ApplicantService(tenantPrisma, systemPrisma, new PanEncryptionService()), new CompanyService(tenantPrisma, systemPrisma), null as any);
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  // ── Capability isolation (Proxy denial) ──────────────────────

  it('accessing ctx.http without declaring the outbound-http capability throws PluginCapabilityError', () => {
    const plugin = makePlugin([]); // declares nothing
    const ctx = runtime.buildContext(plugin, fx.companyId, {});
    expect(() => ctx.http).toThrow(PluginCapabilityError);
    expect(() => ctx.http).toThrow(/outbound-http/);
  });

  it('accessing ctx.applicants without declaring applicants.dedup throws PluginCapabilityError', () => {
    const plugin = makePlugin([]);
    const ctx = runtime.buildContext(plugin, fx.companyId, {});
    expect(() => ctx.applicants).toThrow(PluginCapabilityError);
    expect(() => ctx.applicants).toThrow(/applicants\.dedup/);
  });

  it('declaring outbound-http makes ctx.http present (no throw)', () => {
    const plugin = makePlugin(['outbound-http']);
    const ctx = runtime.buildContext(plugin, fx.companyId, {});
    expect(ctx.http).toBeDefined();
  });

  it('declaring applicants.dedup makes ctx.applicants present and functional against real data', async () => {
    const plugin = makePlugin(['applicants.dedup']);
    const applicant = await systemPrisma.applicant.create({
      data: { companyId: fx.companyId, name: 'Dedup Fixture', primaryPhone: '9812300000', primaryPhoneNormalized: '9812300000' },
    });
    const ctx = runtime.buildContext(plugin, fx.companyId, {});
    const dupes = await ctx.applicants!.findDuplicates('9812300000');
    expect(dupes.map((d) => d.id)).toContain(applicant.id);
  });

  it('secretHeader() for an undeclared secret field throws PluginCapabilityError', () => {
    const plugin = makePlugin([], [{ key: 'apiKey', label: 'API Key', type: 'password', required: true, secret: true }]);
    const ctx = runtime.buildContext(plugin, fx.companyId, {}); // no apiKey provided
    expect(() => ctx.secretHeader('notAField', (v) => v)).toThrow(PluginCapabilityError);
  });

  // ── Secret handling (addendum A1) ────────────────────────────

  it('a config field marked secret is a SecretRef in ctx.config, never the plaintext', () => {
    const plugin = makePlugin([], [{ key: 'apiKey', label: 'API Key', type: 'password', required: true, secret: true }]);
    const ctx = runtime.buildContext(plugin, fx.companyId, { apiKey: 'super-secret-value' });

    expect(isSecretRef(ctx.config.apiKey)).toBe(true);
    expect(JSON.stringify(ctx.config)).not.toContain('super-secret-value');
  });

  it('a non-secret config field holds its real value in ctx.config', () => {
    const plugin = makePlugin([], [{ key: 'senderId', label: 'Sender ID', type: 'text', required: false }]);
    const ctx = runtime.buildContext(plugin, fx.companyId, { senderId: 'ACME' });
    expect(ctx.config.senderId).toBe('ACME');
  });

  it('secretHeader() resolves to the correctly-formatted plaintext for a declared secret field', () => {
    const plugin = makePlugin([], [{ key: 'apiKey', label: 'API Key', type: 'password', required: true, secret: true }]);
    const ctx = runtime.buildContext(plugin, fx.companyId, { apiKey: 'my-real-key' });
    const spec = ctx.secretHeader('apiKey', (v) => `Bearer ${v}`);
    expect(spec.format('my-real-key')).toBe('Bearer my-real-key');
    expect(spec.fieldKey).toBe('apiKey');
  });

  // ── companyId is fixed, read-only ────────────────────────────

  it('ctx.companyId matches the company the context was built for', () => {
    const plugin = makePlugin([]);
    const ctx = runtime.buildContext(plugin, fx.companyId, {});
    expect(ctx.companyId).toBe(fx.companyId);
  });

  // ── invoke(): throw/timeout never propagate ──────────────────

  it('invoke() converts a thrown error into a structured failure, never propagating it', async () => {
    const result = await runtime.invoke('test-plugin', 'someHook', fx.companyId, 1000, async () => {
      throw new Error('boom');
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.pluginId).toBe('test-plugin');
      expect(result.error.hook).toBe('someHook');
      expect(result.error.message).toBe('boom');
    }
  });

  it('invoke() converts a non-Error throw into a structured failure too', async () => {
    const result = await runtime.invoke('test-plugin', 'someHook', fx.companyId, 1000, async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'a string throw, not an Error instance';
    });
    expect(result.ok).toBe(false);
  });

  it('invoke() converts a never-resolving hook into a timeout failure, not a hang', async () => {
    const result = await runtime.invoke('test-plugin', 'someHook', fx.companyId, 100, () => new Promise(() => {})); // never resolves
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/timeout after 100ms/);
    }
  });

  it('invoke() returns the real value on success', async () => {
    const result = await runtime.invoke('test-plugin', 'someHook', fx.companyId, 1000, async () => 42);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  // ── Defense-in-depth cross-check against Phase 6's guardrail ─

  it("real plugins never hold a runWithTenant reference — but the guardrail it would hit still works (defense-in-depth), simulated by calling it directly the way no real plugin can", () => {
    expect(() =>
      runWithTenant({ companyId: fx.companyId, portalBrokerId: 'broker-a' }, () => {
        runWithTenant({ companyId: fx.companyId, portalBrokerId: 'broker-b' }, () => undefined);
      }),
    ).toThrow(/refusing to widen an active portal scope/);
  });
});
