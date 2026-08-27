/**
 * Dispatch module: enqueue → SENT via the dev provider, visible in
 * applicant/booking dispatch history; a FAILED dispatch's retry() creates a
 * NEW attempt row referencing the original rather than mutating it, and
 * retrying a non-FAILED dispatch is rejected.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM + Redis.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { DISPATCH_STATUS } from '@openestate/shared';
import { DispatchService } from '../src/dispatch/dispatch.service';
import { DispatchProcessor } from '../src/dispatch/dispatch.processor';
import {
  ConsoleCommunicationProvider,
  type CommunicationProvider,
  type CommunicationMessage,
  type CommunicationSendResult,
} from '../src/queues/communication-provider';
import { makeClients, seedCompany, makeApplicant, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const REDIS_TEST_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';
const shouldRun = !!(APP_URL && SYSTEM_URL);
const describeIf = shouldRun ? describe : describe.skip;

/** Simulates a provider outage so the FAILED/retry path is reachable without flaking the dev provider. */
class FlakyProvider implements CommunicationProvider {
  async send(_message: CommunicationMessage): Promise<CommunicationSendResult> {
    return { success: false, error: 'simulated provider outage' };
  }
}

function newRedis() {
  return new Redis(REDIS_TEST_URL, { maxRetriesPerRequest: null });
}

describeIf('Dispatch module (BullMQ)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let applicantId: string;

  let sentQueue: Queue;
  let sentWorker: Worker;
  let sentDispatchSvc: DispatchService;

  let failQueue: Queue;
  let failWorker: Worker;
  let failDispatchSvc: DispatchService;

  async function makeDoc() {
    return systemPrisma.generatedDocument.create({
      data: {
        companyId: fx.companyId,
        applicantId,
        documentType: 'RECEIPT',
        storedName: `${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`,
        originalName: 'receipt.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1234,
      },
    });
  }

  function waitForCompletion(worker: Worker, dispatchId: string) {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for dispatch job')), 10_000);
      worker.on('completed', (job) => {
        if (job.data.dispatchId === dispatchId) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  }

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    applicantId = await makeApplicant(systemPrisma, fx.companyId);

    const sentQueueName = `dispatch-sent-test-${Date.now()}`;
    sentQueue = new Queue(sentQueueName, { connection: newRedis() });
    sentDispatchSvc = new DispatchService(tenantPrisma, systemPrisma, sentQueue);
    const sentProcessor = new DispatchProcessor(tenantPrisma, new ConsoleCommunicationProvider());
    sentWorker = new Worker(sentQueueName, (job) => sentProcessor.process(job), { connection: newRedis() });

    const failQueueName = `dispatch-fail-test-${Date.now()}`;
    failQueue = new Queue(failQueueName, { connection: newRedis() });
    failDispatchSvc = new DispatchService(tenantPrisma, systemPrisma, failQueue);
    const failProcessor = new DispatchProcessor(tenantPrisma, new FlakyProvider());
    failWorker = new Worker(failQueueName, (job) => failProcessor.process(job), { connection: newRedis() });
  });

  afterAll(async () => {
    await sentWorker.close();
    await sentQueue.obliterate({ force: true }).catch(() => {});
    await sentQueue.close();
    await failWorker.close();
    await failQueue.obliterate({ force: true }).catch(() => {});
    await failQueue.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('enqueue → dev provider marks SENT → visible in applicant dispatch history', async () => {
    const doc = await makeDoc();
    const dispatch = await sentDispatchSvc.send(fx.companyId, doc.id, 'applicant@test.com', 'EMAIL', fx.userId);
    expect(dispatch.status).toBe(DISPATCH_STATUS.QUEUED);

    await waitForCompletion(sentWorker, dispatch.id);

    const updated = await systemPrisma.documentDispatch.findUnique({ where: { id: dispatch.id } });
    expect(updated.status).toBe(DISPATCH_STATUS.SENT);
    expect(updated.providerMessageId).toBeTruthy();

    const history = await sentDispatchSvc.historyForApplicant(fx.companyId, applicantId);
    expect(history.map((h: { id: string }) => h.id)).toContain(dispatch.id);
  });

  it('a FAILED dispatch retry() creates a new attempt row referencing the original, which stays untouched', async () => {
    const doc = await makeDoc();
    const dispatch = await failDispatchSvc.send(fx.companyId, doc.id, 'fail@test.com', 'EMAIL', fx.userId);

    await waitForCompletion(failWorker, dispatch.id);

    const failed = await systemPrisma.documentDispatch.findUnique({ where: { id: dispatch.id } });
    expect(failed.status).toBe(DISPATCH_STATUS.FAILED);
    expect(failed.errorMessage).toBeTruthy();

    const attempt = await failDispatchSvc.retry(fx.companyId, dispatch.id, fx.userId);
    expect(attempt.id).not.toBe(dispatch.id);
    expect(attempt.attemptOfDispatchId).toBe(dispatch.id);
    expect(attempt.status).toBe(DISPATCH_STATUS.QUEUED);

    // The original attempt is never mutated back to QUEUED — a fresh row carries the retry.
    const originalAfterRetry = await systemPrisma.documentDispatch.findUnique({ where: { id: dispatch.id } });
    expect(originalAfterRetry.status).toBe(DISPATCH_STATUS.FAILED);

    const history = await failDispatchSvc.historyForApplicant(fx.companyId, applicantId);
    const historyIds = history.map((h: { id: string }) => h.id);
    expect(historyIds).toContain(dispatch.id);
    expect(historyIds).toContain(attempt.id);

    // Retrying a non-FAILED dispatch (the fresh QUEUED attempt) is rejected.
    await expect(failDispatchSvc.retry(fx.companyId, attempt.id, fx.userId)).rejects.toThrow();
  });
});
