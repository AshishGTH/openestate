import { Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA } from '../database/database.module';
import { COMMUNICATION_QUEUE } from './queues.module';
import { COMMUNICATION_PROVIDER, type CommunicationProvider } from './communication-provider';

interface SendJobData {
  companyId: string;
  communicationLogId: string;
}

@Processor(COMMUNICATION_QUEUE)
export class CommunicationProcessor extends WorkerHost {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(COMMUNICATION_PROVIDER)
    private readonly provider: CommunicationProvider,
  ) {
    super();
  }

  async process(job: Job<SendJobData>): Promise<void> {
    if (job.name !== 'send') return;
    const { companyId, communicationLogId } = job.data;

    const log = await runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.communicationLog.findFirst({ where: { id: communicationLogId, companyId } }),
      ),
    );
    if (!log) return;

    // Provider call is external I/O — deliberately outside any withTenantTx.
    const result = await this.provider.send({
      channel: log.channel,
      toAddress: log.toAddress,
      subject: log.subject ?? undefined,
      body: log.body,
    });

    await runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.communicationLog.update({
          where: { id: communicationLogId },
          data: result.success
            ? { status: 'SENT', providerMessageId: result.providerMessageId, sentAt: new Date() }
            : { status: 'FAILED', errorMessage: result.error ?? 'Unknown error' },
        }),
      ),
    );
  }
}
