import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ESCALATION_QUEUE } from '../queues/queues.module';
import { EscalationService } from './escalation.service';

interface CompanyEscalationJobData {
  companyId: string;
}

@Processor(ESCALATION_QUEUE)
export class EscalationProcessor extends WorkerHost {
  constructor(private readonly escalationService: EscalationService) {
    super();
  }

  async process(job: Job<CompanyEscalationJobData>): Promise<unknown> {
    if (job.name === 'tick') {
      return this.escalationService.dispatchTick();
    }
    if (job.name === 'company-escalation') {
      return this.escalationService.runForCompany(job.data.companyId);
    }
    return undefined;
  }
}
