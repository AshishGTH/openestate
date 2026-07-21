/**
 * Communication send action: creates a CommunicationLog row and enqueues
 * a BullMQ job for the dev provider to process.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM + Redis.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { createTenantPrismaClient, createSystemPrismaClient } from '@openestate/db';
import { CommunicationService } from '../src/presales/communication.service';
import { CommunicationProcessor } from '../src/queues/communication.processor';
import { ConsoleCommunicationProvider } from '../src/queues/communication-provider';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const REDIS_TEST_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6380';
const shouldRun = !!(APP_URL && SYSTEM_URL);
const describeIf = shouldRun ? describe : describe.skip;

describeIf('Communication send action (BullMQ)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let queue: Queue;
  let worker: Worker;
  let communicationService: CommunicationService;
  let companyId: string;
  let applicantId: string;

  beforeAll(async () => {
    tenantPrisma = createTenantPrismaClient(APP_URL!);
    systemPrisma = createSystemPrismaClient(SYSTEM_URL!);

    const connection = new Redis(REDIS_TEST_URL, { maxRetriesPerRequest: null });
    const queueName = `communication-test-${Date.now()}`;
    queue = new Queue(queueName, { connection });
    communicationService = new CommunicationService(tenantPrisma, systemPrisma, queue);

    const processor = new CommunicationProcessor(tenantPrisma, new ConsoleCommunicationProvider());
    worker = new Worker(
      queueName,
      (job) => processor.process(job),
      { connection: new Redis(REDIS_TEST_URL, { maxRetriesPerRequest: null }) },
    );

    const company = await systemPrisma.company.create({
      data: { name: 'Comm Test Co', slug: `comm-test-${Date.now()}` },
    });
    companyId = company.id;
    const applicant = await systemPrisma.applicant.create({
      data: {
        companyId,
        name: 'Comm Applicant',
        primaryPhone: '9876560001',
        primaryPhoneNormalized: '9876560001',
        email: 'comm-applicant@test.com',
      },
    });
    applicantId = applicant.id;
  });

  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
    await systemPrisma.communicationLog.deleteMany({ where: { companyId } });
    await systemPrisma.applicant.deleteMany({ where: { companyId } });
    await systemPrisma.company.delete({ where: { id: companyId } });
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('creates a QUEUED CommunicationLog and enqueues a BullMQ job that the processor picks up and marks SENT', async () => {
    const log = await communicationService.send(
      companyId,
      applicantId,
      undefined,
      { channel: 'EMAIL', subject: 'Hello', body: 'Test message' },
      null,
    );
    expect(log.status).toBe('QUEUED');

    const jobCounts = await queue.getJobCounts('waiting', 'active', 'completed', 'delayed');
    expect(jobCounts.waiting + jobCounts.active + jobCounts.completed + jobCounts.delayed).toBeGreaterThan(0);

    // Wait for the worker to process the job.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for job to complete')), 10_000);
      worker.on('completed', (job) => {
        if (job.data.communicationLogId === log.id) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    const updated = await systemPrisma.communicationLog.findUnique({ where: { id: log.id } });
    expect(updated.status).toBe('SENT');
    expect(updated.providerMessageId).toBeTruthy();
  });

  it('rejects sending EMAIL to an applicant with no email on file', async () => {
    const noEmailApplicant = await systemPrisma.applicant.create({
      data: { companyId, name: 'No Email', primaryPhone: '9876560002', primaryPhoneNormalized: '9876560002' },
    });
    await expect(
      communicationService.send(companyId, noEmailApplicant.id, undefined, { channel: 'EMAIL', body: 'x' }, null),
    ).rejects.toThrow();
  });
});
