import { Module } from '@nestjs/common';
import { ClockProvider, CLOCK } from '../common/clock.provider';
import { PanEncryptionService } from '../common/pan-encryption.service';
import { QueuesModule } from '../queues/queues.module';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { CommunicationProcessor } from '../queues/communication.processor';
import { ApplicantController } from './applicant.controller';
import { ApplicantService } from './applicant.service';
import { InquiryController } from './inquiry.controller';
import { InquiryService } from './inquiry.service';
import { AssignmentPoolController } from './assignment-pool.controller';
import { AssignmentService } from './assignment.service';
import { InquiryImportController } from './inquiry-import.controller';
import { InquiryImportService } from './inquiry-import.service';
import { FollowUpController } from './follow-up.controller';
import { FollowUpService } from './follow-up.service';
import { CommunicationController } from './communication.controller';
import { CommunicationService } from './communication.service';
import { EscalationService } from './escalation.service';
import { EscalationProcessor } from './escalation.processor';
import { EscalationScheduler } from './escalation.scheduler';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [QueuesModule, CustomFieldsModule],
  controllers: [
    ApplicantController,
    InquiryController,
    AssignmentPoolController,
    InquiryImportController,
    FollowUpController,
    CommunicationController,
    ReportsController,
  ],
  providers: [
    ClockProvider,
    PanEncryptionService,
    ApplicantService,
    InquiryService,
    AssignmentService,
    InquiryImportService,
    FollowUpService,
    CommunicationService,
    CommunicationProcessor,
    EscalationService,
    EscalationProcessor,
    EscalationScheduler,
    ReportsService,
  ],
  exports: [CLOCK, AssignmentService, EscalationService, ApplicantService, InquiryService],
})
export class PresalesModule {}
