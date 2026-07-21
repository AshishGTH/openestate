import { Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { withTenantTx, runWithTenant } from '@openestate/db';
import { DISPATCH_STATUS } from '@openestate/shared';
import { TENANT_PRISMA } from '../database/database.module';
import { DISPATCH_QUEUE } from '../queues/queues.module';
import { COMMUNICATION_PROVIDER, type CommunicationProvider } from '../queues/communication-provider';

interface SendJobData {
  companyId: string;
  dispatchId: string;
}

@Processor(DISPATCH_QUEUE)
export class DispatchProcessor extends WorkerHost {
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
    const { companyId, dispatchId } = job.data;

    const dispatch = await runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.documentDispatch.findFirst({ where: { id: dispatchId, companyId } }),
      ),
    );
    if (!dispatch) return;

    // Provider call is external I/O — deliberately outside any withTenantTx.
    const result = await this.provider.send({
      channel: dispatch.channel,
      toAddress: dispatch.recipientAddress,
      body: dispatch.templateSnapshot,
    });

    await runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.documentDispatch.update({
          where: { id: dispatchId },
          data: result.success
            ? { status: DISPATCH_STATUS.SENT, providerMessageId: result.providerMessageId }
            : { status: DISPATCH_STATUS.FAILED, errorMessage: result.error ?? 'Unknown error' },
        }),
      ),
    );
  }
}
