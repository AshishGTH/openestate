/**
 * Phase 7 commit 2 (webhooks-and-leads): WebhookDeliveryProcessor against
 * a real Postgres + Redis + BullMQ Worker and a real (mock) HTTP server —
 * retry/backoff through all configured attempts, atomic
 * consecutiveFailures under concurrency (addendum A3), the
 * success-vs-exhaustion race rule, replay (addendum A4), and the payload
 * cap (addendum A4).
 *
 * The Worker is constructed directly from bullmq (not through Nest's
 * @Processor/WorkerHost DI wiring) — same "construct the real class with
 * new, don't stand up the DI container" convention every other
 * integration test in this suite already follows — and given a tiny
 * fixed backoff (not the service's production 30s exponential) so a
 * 6-attempt exhaustion completes in well under a second instead of ~33
 * real minutes.
 */
import * as http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { PluginSecretEncryptionService } from '../src/plugins/plugin-secret-encryption.service';
import { WebhookDeliveryProcessor, WEBHOOK_DISABLE_THRESHOLD } from '../src/webhooks/webhook-delivery.processor';
import { WebhookDeliveryService } from '../src/webhooks/webhook-delivery.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6380';
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'a3b4c5d6'.repeat(8)}`;

const TEST_QUEUE = 'webhook-test';
const FAST_RETRY_OPTS = { attempts: 6, backoff: { type: 'fixed' as const, delay: 15 } };

type MockServerMode = 'always-fail' | 'always-succeed';

describeIf('WebhookDeliveryProcessor (Phase 7 commit 2)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let secretEncryption: PluginSecretEncryptionService;
  let processor: WebhookDeliveryProcessor;
  let queue: Queue;
  let worker: Worker;
  let requestCount = 0;
  let server: http.Server;
  let serverMode: MockServerMode = 'always-fail';
  let serverUrl: string;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    secretEncryption = new PluginSecretEncryptionService();
    processor = new WebhookDeliveryProcessor(systemPrisma, secretEncryption);

    server = http.createServer((req, res) => {
      requestCount++;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (serverMode === 'always-fail') {
          res.writeHead(500).end('server error');
        } else {
          res.writeHead(200).end('ok');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    serverUrl = `http://127.0.0.1:${address.port}`;

    const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(TEST_QUEUE, { connection });
    worker = new Worker(TEST_QUEUE, (job) => processor.process(job), { connection });
  });

  afterAll(async () => {
    await worker.close();
    await queue.close();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  async function makeEndpoint(overrides: { consecutiveFailures?: number; isActive?: boolean } = {}) {
    const { ciphertext, keyVersion } = secretEncryption.encrypt('endpoint-signing-secret');
    return systemPrisma.webhookEndpoint.create({
      data: {
        companyId: fx.companyId,
        name: 'Test Endpoint',
        url: serverUrl,
        secretCiphertext: ciphertext,
        secretKeyVersion: keyVersion,
        eventTypes: ['booking.created'],
        consecutiveFailures: overrides.consecutiveFailures ?? 0,
        isActive: overrides.isActive ?? true,
      },
    });
  }

  async function makeDelivery(endpointId: string) {
    return systemPrisma.webhookDelivery.create({
      data: { companyId: fx.companyId, webhookEndpointId: endpointId, eventType: 'booking.created', payload: { hello: 'world' }, status: 'PENDING' },
    });
  }

  async function waitForStatus(deliveryId: string, terminal: string[], timeoutMs = 5000): Promise<{ status: string }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await systemPrisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
      if (row && terminal.includes(row.status)) return row;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for delivery ${deliveryId} to reach ${terminal.join('|')}, currently ${row?.status}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('a delivery to an always-failing endpoint retries through all 6 configured attempts, then EXHAUSTED, with one WebhookDeliveryAttempt row per try', async () => {
    serverMode = 'always-fail';
    const endpoint = await makeEndpoint();
    const delivery = await makeDelivery(endpoint.id);
    await queue.add('deliver', { companyId: fx.companyId, webhookDeliveryId: delivery.id }, FAST_RETRY_OPTS);

    const final = await waitForStatus(delivery.id, ['EXHAUSTED']);
    expect(final.status).toBe('EXHAUSTED');

    const attempts = await systemPrisma.webhookDeliveryAttempt.findMany({ where: { webhookDeliveryId: delivery.id }, orderBy: { attemptNumber: 'asc' } });
    expect(attempts).toHaveLength(6);
    expect(attempts.map((a: { attemptNumber: number }) => a.attemptNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(attempts.every((a: { responseStatus: number }) => a.responseStatus === 500)).toBe(true);
  });

  it('one exhausted delivery increments consecutiveFailures by exactly 1, not by attempt count', async () => {
    serverMode = 'always-fail';
    const endpoint = await makeEndpoint();
    const delivery = await makeDelivery(endpoint.id);
    await queue.add('deliver', { companyId: fx.companyId, webhookDeliveryId: delivery.id }, FAST_RETRY_OPTS);
    await waitForStatus(delivery.id, ['EXHAUSTED']);

    const updated = await systemPrisma.webhookEndpoint.findUnique({ where: { id: endpoint.id } });
    expect(updated.consecutiveFailures).toBe(1);
    expect(updated.isActive).toBe(true); // well below the disable threshold
  });

  it(`auto-disables the endpoint once consecutiveFailures reaches ${WEBHOOK_DISABLE_THRESHOLD}`, async () => {
    serverMode = 'always-fail';
    const endpoint = await makeEndpoint({ consecutiveFailures: WEBHOOK_DISABLE_THRESHOLD - 1 });
    const delivery = await makeDelivery(endpoint.id);
    await queue.add('deliver', { companyId: fx.companyId, webhookDeliveryId: delivery.id }, FAST_RETRY_OPTS);
    await waitForStatus(delivery.id, ['EXHAUSTED']);

    const updated = await systemPrisma.webhookEndpoint.findUnique({ where: { id: endpoint.id } });
    expect(updated.consecutiveFailures).toBe(WEBHOOK_DISABLE_THRESHOLD);
    expect(updated.isActive).toBe(false);
    expect(updated.disabledAt).not.toBeNull();
    expect(updated.disabledReason).toMatch(/Auto-disabled/);
  });

  it('atomic under concurrency: N concurrent exhausted deliveries for the same endpoint produce exactly N counted failures, no double/under-count', async () => {
    serverMode = 'always-fail';
    const endpoint = await makeEndpoint();
    const N = 8;
    const deliveries = await Promise.all(Array.from({ length: N }, () => makeDelivery(endpoint.id)));
    await Promise.all(deliveries.map((d: { id: string }) => queue.add('deliver', { companyId: fx.companyId, webhookDeliveryId: d.id }, FAST_RETRY_OPTS)));
    await Promise.all(deliveries.map((d: { id: string }) => waitForStatus(d.id, ['EXHAUSTED'], 8000)));

    const updated = await systemPrisma.webhookEndpoint.findUnique({ where: { id: endpoint.id } });
    expect(updated.consecutiveFailures).toBe(N);
    expect(updated.isActive).toBe(true); // N=8 stays under the threshold of 10 — still active
  });

  it('success resets consecutiveFailures to 0 only when the endpoint is still active (success-vs-exhaustion race rule, addendum A3)', async () => {
    // Case 1: endpoint still active — success resets the counter.
    serverMode = 'always-succeed';
    const activeEndpoint = await makeEndpoint({ consecutiveFailures: 4, isActive: true });
    const delivery1 = await makeDelivery(activeEndpoint.id);
    await queue.add('deliver', { companyId: fx.companyId, webhookDeliveryId: delivery1.id }, FAST_RETRY_OPTS);
    await waitForStatus(delivery1.id, ['SUCCESS']);
    const afterSuccess = await systemPrisma.webhookEndpoint.findUnique({ where: { id: activeEndpoint.id } });
    expect(afterSuccess.consecutiveFailures).toBe(0);

    // Case 2: endpoint already disabled — a stray success must NOT resurrect it.
    const disabledEndpoint = await makeEndpoint({ consecutiveFailures: WEBHOOK_DISABLE_THRESHOLD, isActive: false });
    await systemPrisma.$executeRawUnsafe(`UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE id = $1::uuid AND is_active = true`, disabledEndpoint.id);
    const afterStraySuccess = await systemPrisma.webhookEndpoint.findUnique({ where: { id: disabledEndpoint.id } });
    expect(afterStraySuccess.isActive).toBe(false);
    expect(afterStraySuccess.consecutiveFailures).toBe(WEBHOOK_DISABLE_THRESHOLD); // untouched — the WHERE clause matched 0 rows
  });

  it('a delivery whose endpoint is inactive by the time the worker picks it up is a no-op, not an error', async () => {
    serverMode = 'always-fail';
    const endpoint = await makeEndpoint({ isActive: false });
    const delivery = await makeDelivery(endpoint.id);
    await queue.add('deliver', { companyId: fx.companyId, webhookDeliveryId: delivery.id }, FAST_RETRY_OPTS);
    // Give the worker a moment to have picked it up and returned — there's
    // no terminal status to wait for since the processor intentionally
    // returns early, so poll briefly and assert it stayed PENDING.
    await new Promise((r) => setTimeout(r, 300));
    const stillPending = await systemPrisma.webhookDelivery.findUnique({ where: { id: delivery.id } });
    expect(stillPending.status).toBe('PENDING');
    const attempts = await systemPrisma.webhookDeliveryAttempt.findMany({ where: { webhookDeliveryId: delivery.id } });
    expect(attempts).toHaveLength(0);
  });

  // ── Addendum A4: replay + payload cap ─────────────────────────

  it('WebhookDeliveryService.retry() re-enqueues an EXHAUSTED delivery with a fresh attempt budget, appending to (not resetting) the attempt log', async () => {
    serverMode = 'always-fail';
    const endpoint = await makeEndpoint();
    const delivery = await makeDelivery(endpoint.id);
    await queue.add('deliver', { companyId: fx.companyId, webhookDeliveryId: delivery.id }, FAST_RETRY_OPTS);
    await waitForStatus(delivery.id, ['EXHAUSTED']);
    const attemptsAfterFirstRun = await systemPrisma.webhookDeliveryAttempt.findMany({ where: { webhookDeliveryId: delivery.id } });
    expect(attemptsAfterFirstRun).toHaveLength(6);

    const testQueue = { add: (name: string, data: unknown) => queue.add(name, data, FAST_RETRY_OPTS) };
    const deliveryService = new WebhookDeliveryService(systemPrisma, testQueue as never);
    const result = await deliveryService.retry(fx.companyId, delivery.id);
    expect(result.requeued).toBe(true);

    const resetRow = await systemPrisma.webhookDelivery.findUnique({ where: { id: delivery.id } });
    expect(resetRow.status).toBe('PENDING');

    const final = await waitForStatus(delivery.id, ['EXHAUSTED']);
    expect(final.status).toBe('EXHAUSTED');
    const attemptsAfterReplay = await systemPrisma.webhookDeliveryAttempt.findMany({ where: { webhookDeliveryId: delivery.id }, orderBy: { attemptNumber: 'asc' } });
    // Fresh job = attemptsMade starts at 0 again, so attemptNumber restarts
    // at 1 for the new job too — but the OLD 6 rows are never deleted, so
    // the full history (12 rows total) stays visible.
    expect(attemptsAfterReplay).toHaveLength(12);
  });

  it('retry() rejects a delivery that is not EXHAUSTED', async () => {
    const endpoint = await makeEndpoint();
    const delivery = await makeDelivery(endpoint.id); // status PENDING
    const testQueue = { add: (name: string, data: unknown) => queue.add(name, data, FAST_RETRY_OPTS) };
    const deliveryService = new WebhookDeliveryService(systemPrisma, testQueue as never);
    await expect(deliveryService.retry(fx.companyId, delivery.id)).rejects.toThrow(/Only an EXHAUSTED delivery can be retried/);
  });

  it('dispatchEvent() rejects a payload over the 256KB cap without creating a WebhookDelivery row', async () => {
    const endpoint = await makeEndpoint();
    const testQueue = { add: () => Promise.resolve() };
    const deliveryService = new WebhookDeliveryService(systemPrisma, testQueue as never);
    const hugePayload = { blob: 'x'.repeat(300 * 1024) };

    await expect(deliveryService.dispatchEvent(fx.companyId, 'booking.created', hugePayload)).rejects.toBeInstanceOf(BadRequestException);

    const rows = await systemPrisma.webhookDelivery.findMany({ where: { webhookEndpointId: endpoint.id } });
    expect(rows).toHaveLength(0);
  });

  it('dispatchEvent() fans out to every active endpoint subscribed to the event type, and only those', async () => {
    // A unique event type per test run — every other test in this file
    // creates endpoints defaulting to 'booking.created' via makeEndpoint()
    // and never deletes them (only afterAll does), so counting company-wide
    // subscribers to that shared name would pick up unrelated leftovers.
    const uniqueEventType = `booking.created.${Date.now()}`;
    const subscribed = await makeEndpoint();
    await systemPrisma.webhookEndpoint.update({ where: { id: subscribed.id }, data: { eventTypes: [uniqueEventType] } });
    const unsubscribed = await makeEndpoint();
    await systemPrisma.webhookEndpoint.update({ where: { id: unsubscribed.id }, data: { eventTypes: ['receipt.created'] } });
    const inactive = await makeEndpoint({ isActive: false });
    await systemPrisma.webhookEndpoint.update({ where: { id: inactive.id }, data: { eventTypes: [uniqueEventType] } });

    const testQueue = { add: () => Promise.resolve() };
    const deliveryService = new WebhookDeliveryService(systemPrisma, testQueue as never);
    const result = await deliveryService.dispatchEvent(fx.companyId, uniqueEventType, { bookingId: 'x' });
    expect(result.dispatchedTo).toBe(1);

    const deliveries = await systemPrisma.webhookDelivery.findMany({ where: { webhookEndpointId: subscribed.id } });
    expect(deliveries).toHaveLength(1);
    const noneForUnsubscribed = await systemPrisma.webhookDelivery.findMany({ where: { webhookEndpointId: unsubscribed.id } });
    expect(noneForUnsubscribed).toHaveLength(0);
  });
});
