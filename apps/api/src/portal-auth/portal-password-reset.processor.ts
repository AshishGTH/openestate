import { Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { randomUUID, createHash } from 'node:crypto';
import { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';
import { PORTAL_QUEUE } from '../queues/queues.module';
import { COMMUNICATION_PROVIDER, type CommunicationProvider } from '../queues/communication-provider';

export const PROCESS_PASSWORD_RESET_JOB = 'process-password-reset-request';

interface PasswordResetJobData {
  // null when the request-path lookup found no matching identifier — this
  // job still runs (structural timing equality, see CLAUDE.md Phase 6
  // decisions), it just no-ops below rather than never having been enqueued.
  userId: string | null;
  companyId: string | null;
}

/**
 * All real work for a portal password-reset request happens here, off the
 * request path — the controller only enqueues, synchronously, for both the
 * found and not-found cases, so response timing can't reveal which branch
 * ran. Mirrors DispatchProcessor's shape.
 */
@Processor(PORTAL_QUEUE)
export class PortalPasswordResetProcessor extends WorkerHost {
  constructor(
    @Inject(SYSTEM_PRISMA) private readonly prisma: PrismaClient,
    @Inject(COMMUNICATION_PROVIDER) private readonly provider: CommunicationProvider,
  ) {
    super();
  }

  async process(job: Job<PasswordResetJobData>): Promise<void> {
    if (job.name !== PROCESS_PASSWORD_RESET_JOB) return;
    const { userId, companyId } = job.data;
    if (!userId || !companyId) return;

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) return;

    const raw = randomUUID();
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await this.prisma.portalPasswordReset.create({
      data: { companyId, userId, tokenHash, expiresAt },
    });

    const toAddress = user.email ?? user.phone;
    if (!toAddress) return;

    // Provider call is external I/O — deliberately outside any withTenantTx
    // (this processor never opens one; PortalPasswordReset/User lookups run
    // via the SYSTEM client, same as staff AuthService's password flows).
    await this.provider.send({
      channel: user.email ? 'EMAIL' : 'SMS',
      toAddress,
      subject: 'Reset your OpenEstate portal password',
      body: `Use this code to reset your password: ${raw} (valid for 30 minutes). If you didn't request this, ignore this message.`,
    });
  }
}
