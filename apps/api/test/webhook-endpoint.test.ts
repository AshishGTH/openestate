/**
 * Phase 7 commit 2 (webhooks-and-leads): WebhookEndpointService against
 * real Postgres — secret encrypted at rest, never returned by any read
 * path, and basic enable/disable/CRUD behavior.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { WebhookEndpointService } from '../src/webhooks/webhook-endpoint.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'f1e2d3c4'.repeat(8)}`;

describeIf('WebhookEndpointService (Phase 7 commit 2)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let service: WebhookEndpointService;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    const { PluginSecretEncryptionService } = await import('../src/plugins/plugin-secret-encryption.service');
    service = new WebhookEndpointService(systemPrisma, new PluginSecretEncryptionService());
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('create() stores the signing secret encrypted — the raw DB column never contains the plaintext', async () => {
    const created = await service.create(fx.companyId, { name: 'Slack', url: 'https://hooks.example.com/x', secret: 'top-secret-webhook-key-12345', eventTypes: ['booking.created'] }, fx.userId);

    const row = await systemPrisma.webhookEndpoint.findUnique({ where: { id: created.id } });
    expect(row.secretCiphertext).toBeTruthy();
    expect(row.secretCiphertext).not.toContain('top-secret-webhook-key-12345');
  });

  it('create() never returns the secret in its response', async () => {
    const created = await service.create(fx.companyId, { name: 'Slack2', url: 'https://hooks.example.com/y', secret: 'another-secret-value-6789', eventTypes: ['booking.created'] }, fx.userId);
    expect(created).not.toHaveProperty('secretCiphertext');
    expect(created).not.toHaveProperty('secretKeyVersion');
    expect(JSON.stringify(created)).not.toContain('another-secret-value-6789');
  });

  it('list() and getOne() never return the secret either', async () => {
    const created = await service.create(fx.companyId, { name: 'Slack3', url: 'https://hooks.example.com/z', secret: 'yet-another-secret-value', eventTypes: ['booking.created'] }, fx.userId);

    const list = await service.list(fx.companyId);
    const fromList = list.find((e) => e.id === created.id);
    expect(fromList).not.toHaveProperty('secretCiphertext');

    const fromGet = await service.getOne(fx.companyId, created.id);
    expect(fromGet).not.toHaveProperty('secretCiphertext');
  });

  it('update() with a new secret re-encrypts; omitting secret keeps the existing one', async () => {
    const created = await service.create(fx.companyId, { name: 'Rotate', url: 'https://hooks.example.com/rotate', secret: 'original-secret-value-111', eventTypes: ['booking.created'] }, fx.userId);
    const originalRow = await systemPrisma.webhookEndpoint.findUnique({ where: { id: created.id } });

    await service.update(fx.companyId, created.id, { name: 'Rotate (renamed)' }); // no secret field
    const afterRename = await systemPrisma.webhookEndpoint.findUnique({ where: { id: created.id } });
    expect(afterRename.secretCiphertext).toBe(originalRow.secretCiphertext); // unchanged

    await service.update(fx.companyId, created.id, { secret: 'rotated-secret-value-222' });
    const afterRotate = await systemPrisma.webhookEndpoint.findUnique({ where: { id: created.id } });
    expect(afterRotate.secretCiphertext).not.toBe(originalRow.secretCiphertext);
    expect(afterRotate.secretCiphertext).not.toContain('rotated-secret-value-222');
  });

  it('enable() resets the failure counter; disable() sets disabledAt/disabledReason', async () => {
    const created = await service.create(fx.companyId, { name: 'Toggle', url: 'https://hooks.example.com/toggle', secret: 'toggle-secret-value-333', eventTypes: ['booking.created'] }, fx.userId);
    await systemPrisma.webhookEndpoint.update({ where: { id: created.id }, data: { consecutiveFailures: 7, isActive: false, disabledAt: new Date(), disabledReason: 'test' } });

    await service.enable(fx.companyId, created.id);
    const afterEnable = await systemPrisma.webhookEndpoint.findUnique({ where: { id: created.id } });
    expect(afterEnable.isActive).toBe(true);
    expect(afterEnable.consecutiveFailures).toBe(0);
    expect(afterEnable.disabledAt).toBeNull();

    await service.disable(fx.companyId, created.id);
    const afterDisable = await systemPrisma.webhookEndpoint.findUnique({ where: { id: created.id } });
    expect(afterDisable.isActive).toBe(false);
    expect(afterDisable.disabledAt).not.toBeNull();
    expect(afterDisable.disabledReason).toBeTruthy();
  });

  it('remove() deletes the endpoint row', async () => {
    const created = await service.create(fx.companyId, { name: 'ToDelete', url: 'https://hooks.example.com/del', secret: 'delete-me-secret-value', eventTypes: ['booking.created'] }, fx.userId);
    await service.remove(fx.companyId, created.id);
    const row = await systemPrisma.webhookEndpoint.findUnique({ where: { id: created.id } });
    expect(row).toBeNull();
  });

  it('getOne() 404s for an endpoint belonging to a different company', async () => {
    const otherFx = await seedCompany(systemPrisma);
    const created = await service.create(otherFx.companyId, { name: 'OtherCo', url: 'https://hooks.example.com/other', secret: 'other-company-secret-value', eventTypes: ['booking.created'] }, otherFx.userId);
    await expect(service.getOne(fx.companyId, created.id)).rejects.toThrow(/not found/i);
    await cleanupCompany(systemPrisma, otherFx.companyId);
  });
});
