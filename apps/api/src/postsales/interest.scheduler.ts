import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';
import { INTEREST_QUEUE } from '../queues/queues.module';
import { InterestService } from './interest.service';

const TICK_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

/**
 * Daily interest-accrual dispatcher. The tick enumerates active companies via
 * the SYSTEM client (id-only projection — never touches financial rows), then
 * dispatches one per-company job. Each per-company job accrues inside that
 * company's tenant transaction (RLS-scoped) — same discipline as the Phase 3
 * escalation job.
 */
@Injectable()
export class InterestScheduler implements OnModuleInit {
  constructor(
    @InjectQueue(INTEREST_QUEUE)
    private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS }, jobId: 'interest-tick' });
  }
}

@Processor(INTEREST_QUEUE)
export class InterestProcessor extends WorkerHost {
  private readonly logger = new Logger(InterestProcessor.name);

  constructor(
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    @InjectQueue(INTEREST_QUEUE)
    private readonly queue: Queue,
    private readonly interest: InterestService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name === 'tick') {
      const companies = await this.systemPrisma.company.findMany({
        where: { isActive: true },
        select: { id: true },
      });
      for (const c of companies) {
        await this.queue.add('company-accrual', { companyId: c.id });
      }
      return companies.map((c: { id: string }) => c.id);
    }
    if (job.name === 'company-accrual') {
      return this.interest.accrueForCompany(job.data.companyId);
    }
    return undefined;
  }
}
