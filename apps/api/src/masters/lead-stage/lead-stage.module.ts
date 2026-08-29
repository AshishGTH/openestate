import { Module } from '@nestjs/common';
import { LeadStageController } from './lead-stage.controller';
import { LeadStageService } from './lead-stage.service';

@Module({
  controllers: [LeadStageController],
  providers: [LeadStageService],
  exports: [LeadStageService],
})
export class LeadStageModule {}
