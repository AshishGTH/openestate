import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { COMMUNICATION_QUEUE } from '../queues/queues.module';
import type { SendCommunicationDto } from '@openestate/shared';

@Injectable()
export class CommunicationService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    @InjectQueue(COMMUNICATION_QUEUE)
    private readonly communicationQueue: Queue,
  ) {}

  async send(
    companyId: string,
    applicantId: string,
    inquiryId: string | undefined,
    dto: SendCommunicationDto,
    actorId: string | null,
  ) {
    const applicant = await this.systemPrisma.applicant.findFirst({
      where: { id: applicantId, companyId },
    });
    if (!applicant) throw new NotFoundException('Applicant not found');
    if (applicant.mergedIntoId) {
      throw new BadRequestException(
        `Applicant has been merged into ${applicant.mergedIntoId}; send to that applicant instead`,
      );
    }

    const toAddress = dto.channel === 'EMAIL' ? applicant.email : applicant.primaryPhone;
    if (!toAddress) {
      throw new BadRequestException(
        `Applicant has no ${dto.channel === 'EMAIL' ? 'email' : 'phone'} on file`,
      );
    }

    const log = await runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.communicationLog.create({
          data: {
            companyId,
            applicantId,
            inquiryId,
            channel: dto.channel,
            toAddress,
            subject: dto.subject,
            body: dto.body,
            status: 'QUEUED',
            createdById: actorId,
          },
        }),
      ),
    );

    // Enqueue AFTER the tx commits — Redis I/O never happens inside withTenantTx.
    await this.communicationQueue.add('send', {
      companyId,
      communicationLogId: log.id,
    });

    return log;
  }
}
